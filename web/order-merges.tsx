import { useEffect, useRef, useState } from 'react';
import { api, ApiError, date, statusNames } from './api';
import './order-merges.css';
import {mergeActor, readMergeIntent, retainMergeIntent, assertHeldMergeIntent, clearMergeIntent, verifyMergeCommand, withMergeCustodyLock, type MergeIntent} from './order-merge-custody';
export type OrdersMergePanelProps = {
  selectedIds: string[];
  contextKey: string;
  readOnly: boolean;
  onOpenOrder: (id: string) => void;
  onError?: (message: string) => void;
  onLockedChange?: (locked: boolean) => void;
};
export type OrdersMergeLineageProps = {
  orderId: string;
  contextKey: string;
  readOnly: boolean;
  onOpenOrder: (id: string) => void;
};
type Mode = 'technical_merge' | 'into_main_order';
type Flags = {
  available: boolean;
  read_only: boolean;
  current_role: string;
  can_read: boolean;
  can_preview: boolean;
  can_execute: boolean;
  can_read_value: boolean;
};
type Options = Flags & {
  limits: {
    orders: number;
    lines: number;
    rows_page: number;
    sources_page: number;
    history_page: number;
    request_bytes: number;
    response_bytes: number;
    preview_bytes: number;
    evidence_bytes: number;
    previews: number;
    executions: number;
  };
};
type Balance = {
  currency: string;
  payment_mode: string;
  received: number;
  refunded: number;
  credit: number;
  nominal: number;
  net: number;
  amount_due: number;
  overpayment: number;
  collected: number;
  remitted: number;
  fees: number;
  courier_due: number;
};
type Source = {
  id: string;
  number: string;
  source: string;
  channel_id: string | null;
  external_id: string | null;
  status: string;
  version: number;
  customer_name: string;
  email: string;
  address: Record<string, unknown>;
  effective_delivery?: {
    kind: 'address' | 'pickup_point' | 'unknown';
    origin: 'original' | 'override' | null;
    delivery: Record<string, string> | null;
    reason: string | null;
  } | null;
  currency: string;
  warehouse_id: string;
  payment_mode: string;
  total: number | null;
  shipping_cost: number | null;
  payment_balance: Balance | null;
  physical_quantity: number;
  physical_scanned: number;
};
type Row = {
  index: number;
  source_order_id: string;
  source_item_id: string;
  product_id: string;
  sku: string;
  name: string;
  quantity: number;
  price: number | null;
  vat: number | null;
  line_total: number | null;
  components: { product_id: string; quantity: number }[];
  scanned: number;
  target_item_id?: string;
};
type Physical = {
  source_order_id: string;
  product_id: string;
  warehouse_id: string;
  location: string;
  layer_id: string | null;
  quantity: number;
  scanned: number;
};
type Head = {
  id: string;
  preview_id?: string;
  state?: 'done';
  total: number;
  source_count: number;
  merge_mode: Mode;
  main_order_id: string;
  target_order_id: string;
  sum_delivery_costs: boolean;
  total_minor: number | null;
  shipping_cost: number | null;
  currency: string;
  payment_mode: string;
  target_status: string;
  physical_count: number;
  physical_quantity: number;
  physical_scanned: number;
  payment_balance: Balance | null;
  receiver_conflict: boolean;
  ready?: boolean;
  conflicts?: string[];
  scope_hash: string;
  created_at: string;
};
type Page<T> = Flags & { data: T[]; meta: { cursor: string | null; total: number } };
type Detail = Flags & { preview?: Head; execution?: Head; meta: { total: number } };
type Evidence = {
  kind: 'preview' | 'execution';
  head: Head;
  sources: Source[];
  rows: Row[];
  physical: Physical[];
  canValue: boolean;
};
type HistoryHead = Head & { kind: 'preview' | 'execution' };
type Attempt = MergeIntent;
type OriginalItem = {
  id: string;
  order_id: string;
  product_id: string;
  sku: string;
  name: string;
  quantity: number;
  scanned: number;
  price: number | null;
  vat: number | null;
  line_total: number | null;
  components: Row['components'];
};
type Lineage = Flags & {
  order_id: string;
  owner_order_id: string;
  closed_source: boolean;
  claims: {
    source_order_id: string;
    target_order_id: string;
    execution_id: string;
    merge_mode: Mode;
  }[];
  origin: null | { header: Source; items: OriginalItem[] };
  created_by?: null | {
    id: string;
    merge_mode: 'technical_merge';
    created_at: string;
    main_order_id: string;
    sources: { id: string; number: string }[];
  };
};
const prefix = '/order-merges';
const modeNames: Record<Mode, string> = {
  technical_merge: 'Nowe zamówienie techniczne',
  into_main_order: 'Połącz do głównego zamówienia',
};
const uuid = (id: string) => /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id);
function amount(v: number | string | null | undefined, currency: string) {
  if (v === null || v === undefined) return 'Brak odczytu kwoty';
  const n = BigInt(v),
    a = n < 0n ? -n : n;
  return `${n < 0n ? '−' : ''}${a / 100n},${String(a % 100n).padStart(2, '0')} ${currency}`;
}
function conflictLabel(code: string) {
  const labels: Record<string, string> = {
    different_currency: 'Różne waluty źródeł — łączenie bez przeliczeń jest zablokowane.',
    different_warehouse: 'Źródła korzystają z różnych magazynów.',
    different_payment_mode: 'Źródła mają różne sposoby płatności.',
    existing_shipments: 'Istnieje już przesyłka.',
    existing_documents: 'Istnieje już dokument.',
    existing_return_cases: 'Istnieje już zgłoszenie zwrotu.',
    active_picking_wave: 'Źródło jest w aktywnej partii kompletacji.',
    active_packing_session: 'Źródło jest w aktywnej sesji pakowania.',
    non_active_reservation: 'Rezerwacja źródłowa nie jest aktywna.',
  };
  if (labels[code]) return labels[code];
  if (code.startsWith('not_pre_fulfillment:'))
    return 'Zamówienie nie jest przed realizacją: ' + code.split(':')[1];
  if (code.startsWith('provider_attempt:'))
    return (
      'Rozpoczęto lub zakończono zapis zewnętrzny; potrzebne uzgodnienie: ' + code.split(':')[1]
    );
  return code;
}
function Address({ address }: { address: Record<string, unknown> }) {
  const entries = Object.entries(address);
  const labels: Record<string, string> = {
    street: 'Ulica',
    city: 'Miejscowość',
    postal_code: 'Kod pocztowy',
    country: 'Kraj',
    phone: 'Telefon',
    company: 'Firma',
    name: 'Odbiorca',
    recipient_name: 'Odbiorca',
    locker_code: 'Punkt odbioru',
  };
  return entries.length ? (
    <dl className="om-facts">
      {entries.map(([key, value]) => (
        <div key={key}>
          <dt>{labels[key] ?? key}</dt>
          <dd>
            {typeof value === 'string' || typeof value === 'number'
              ? String(value)
              : value == null
                ? 'Nie podano'
                : JSON.stringify(value)}
          </dd>
        </div>
      ))}
    </dl>
  ) : (
    <p>Nie podano adresu.</p>
  );
}
function assertDeliveryProjection(value: Source['effective_delivery']) {
  if (value == null) return; // Historical snapshots predate delivery capture.
  const fail = () => { throw Error('Nie potwierdzono operacyjnego adresu dostawy.'); };
  if (typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'delivery,kind,origin,reason') fail();
  if (value.kind === 'address') {
    const d = value.delivery;
    if (!['original', 'override'].includes(value.origin ?? '') || value.reason !== null ||
        !d || Array.isArray(d) || Object.keys(d).sort().join(',') !== 'city,country,phone,postal_code,recipient_name,street' ||
        Object.values(d).some(v => typeof v !== 'string' || v.length > 800) ||
        !/^[A-Z]{2}$/.test(d.country)) fail();
  } else if (!['unknown', 'pickup_point'].includes(value.kind) || value.origin !== null ||
      value.delivery !== null || value.reason !== (value.kind === 'unknown' ? 'delivery_kind_unknown' : 'pickup_point_delivery')) fail();
}
function DeliveryView({ value }: { value: Source['effective_delivery'] }) {
  return <section aria-label="Operacyjny adres dostawy">
    <h5>Operacyjna dostawa</h5>
    {value == null ? <p>Historyczny zapis nie zawiera operacyjnego adresu dostawy.</p>
      : value.kind === 'address' ? <>
        <p>{value.origin === 'override' ? 'Adres zmieniony przez kupującego' : 'Potwierdzona dostawa na adres'}</p>
        <Address address={value.delivery ?? {}} />
      </> : <p>{value.kind === 'pickup_point' ? 'Dostawa do punktu odbioru wskazanego w danych źródłowych.' : 'Rodzaj dostawy nie został potwierdzony.'}</p>}
  </section>;
}
function BalanceView({ balance, canValue }: { balance: Balance | null; canValue: boolean }) {
  if (!canValue)
    return (
      <p className="om-hint">Saldo płatności wymaga bieżącego dostępu do danych finansowych.</p>
    );
  if (!balance || typeof balance.currency !== 'string')
    return <p className="om-hint">Nie wyliczono salda dla tego podglądu.</p>;
  const fields: [keyof Balance, string][] = [
    ['nominal', 'Należność'],
    ['received', 'Wpłaty i pobrania'],
    ['refunded', 'Zwrócono'],
    ['credit', 'Uznane pomniejszenie należności'],
    ['net', 'Wpłaty po zwrotach'],
    ['amount_due', 'Pozostało do zapłaty'],
    ['overpayment', 'Nadpłata'],
    ['collected', 'Pobrania kuriera'],
    ['remitted', 'Przekazano od kuriera'],
    ['fees', 'Opłaty kuriera'],
    ['courier_due', 'Pozostało od kuriera'],
  ];
  return (
    <>
      <dl className="om-facts">
        {fields.map(([key, label]) => (
          <div key={key}>
            <dt>{label}</dt>
            <dd>{amount(balance[key] as number, balance.currency)}</dd>
          </div>
        ))}
      </dl>
      <p className="om-hint">
        Nadpłata jest stanem rozliczenia. Łączenie nie wykonuje zwrotu pieniędzy ani nowego
        pobrania.
      </p>
    </>
  );
}
function MergeEvidence({ evidence, canValue, onOpenOrder, openBlocked }: {
  evidence: Evidence;
  canValue: boolean;
  onOpenOrder: (id: string) => void;
  openBlocked: boolean;
}) {
  const h = evidence.head,
    show = canValue && evidence.canValue;
  const names = new Map(evidence.sources.map((s) => [s.id, s.number]));
  const currencies = new Map(evidence.sources.map((s) => [s.id, s.currency]));
  const conflicts = evidence.kind === 'preview' ? (h.conflicts ?? []) : [];
  const sameCurrency = !conflicts.includes('different_currency');
  return (
    <section className="om-card" aria-label="Pełny zamrożony podgląd połączenia">
      <h3>
        {evidence.kind === 'execution' ? 'Zapisane połączenie' : 'Podgląd połączenia'} ·{' '}
        {modeNames[h.merge_mode]}
      </h3>
      <p>
        {h.source_count} zamówień · {h.total} pozycji sprzedaży · {h.physical_count} pozycji
        rezerwacji. Odczytano wszystkie źródła, pozycje i rezerwacje.
      </p>
      <p>
        Główne zamówienie: <strong>{names.get(h.main_order_id) ?? h.main_order_id}</strong>.{' '}
        {h.sum_delivery_costs
          ? 'Koszt dostawy jest sumą wszystkich źródeł.'
          : 'Zachowano wyłącznie koszt dostawy głównego zamówienia.'}
      </p>
      <p>
        {h.merge_mode === 'technical_merge'
          ? 'Realizacja i rezerwacje przejdą do nowego zamówienia technicznego. Źródła pozostaną dostępne w historii, z zachowanymi nagłówkami i pozycjami. Nie powstaje drugi zestaw rezerwacji ani wpłat.'
          : 'Pozycje i realizacja przechodzą do głównego zamówienia. Pozostałe źródła pozostają w archiwum z audytem; nie są anulowane ani usuwane z bazy.'}
      </p>
      <p>
        Waluta: {h.currency} · {h.payment_mode === 'cod' ? 'Pobranie' : 'Przedpłata'} · status
        wynikowy: {statusNames[h.target_status] ?? h.target_status}.
        {show && sameCurrency && (
          <>
            {' '}
            Łącznie {amount(h.total_minor, h.currency)}, w tym dostawa{' '}
            {amount(h.shipping_cost, h.currency)}.
          </>
        )}
      </p>
      {!sameCurrency && (
        <p className="om-hint">
          Nie prezentujemy wspólnej kwoty dla różnych walut. Każda pozycja zachowuje walutę własnego
          źródła; zapis jest zablokowany.
        </p>
      )}
      <BalanceView balance={h.payment_balance} canValue={show} />
      <p className="om-hint">
        Stan „spakowane” nie jest przenoszony na wynik. Przed wysyłką potrzebne jest ponowne
        pakowanie połączonego zamówienia.
      </p>
      {!!conflicts.length && (
        <div className="om-error" role="alert">
          <strong>Całe połączenie jest zablokowane:</strong>
          <ul>
            {conflicts.map((c, i) => (
              <li key={i}>{conflictLabel(c)}</li>
            ))}
          </ul>
        </div>
      )}
      {h.receiver_conflict && (
        <p className="om-hint">
          Dane odbiorców różnią się. Adres i dane wybranego głównego zamówienia będą danymi
          wynikowymi; pozostałe źródła zachowują historię. Wymagane jest osobne potwierdzenie wyboru
          odbiorcy.
        </p>
      )}
      <h4>Źródłowe zamówienia i odbiorcy</h4>
      {evidence.sources.map((s) => (
        <details className="om-card" key={s.id} open={s.id === h.main_order_id}>
          <summary>
            {s.number} · {s.id === h.main_order_id ? 'Główne · ' : ''}
            {s.customer_name} · {statusNames[s.status] ?? s.status} · wersja {s.version}
          </summary>
          <p>
            {s.email} · źródło {s.source}
            {s.external_id ? ` · numer w źródle ${s.external_id}` : ''}. {s.currency} ·{' '}
            {s.payment_mode === 'cod' ? 'Pobranie' : 'Przedpłata'}
            {show
              ? ` · wartość ${amount(s.total, s.currency)} · dostawa ${amount(s.shipping_cost, s.currency)}`
              : ''}
            .
          </p>
          <h5>Pierwotne dane adresowe</h5>
          <Address address={s.address} />
          <DeliveryView value={s.effective_delivery} />
          <button className="button" disabled={openBlocked} onClick={() => onOpenOrder(s.id)}>
            Otwórz zamówienie źródłowe {s.number}
          </button>
          <BalanceView balance={s.payment_balance} canValue={show} />
          <p>
            Fizyczne sztuki: {s.physical_quantity} · zeskanowano: {s.physical_scanned}.
          </p>
          <details>
            <summary>Identyfikatory źródła i magazynu</summary>
            <p>
              Zamówienie {s.id} · kanał {s.channel_id ?? 'brak'} · magazyn {s.warehouse_id}
            </p>
          </details>
        </details>
      ))}
      <h4>Pozycje sprzedaży — historyczne ceny, VAT i skład</h4>
      <p>
        Ten sam SKU może występować w kilku pozycjach z różną ceną lub składem. Nie przeliczamy ich
        z dzisiejszego katalogu.
      </p>
      <div className="om-table">
        <table>
          <thead>
            <tr>
              <th>Źródło</th>
              <th>Pozycja</th>
              <th>Ilość</th>
              <th>Cena brutto / VAT</th>
              <th>Wartość brutto</th>
              <th>Zachowany skład</th>
            </tr>
          </thead>
          <tbody>
            {evidence.rows.map((r) => (
              <tr key={r.index}>
                <td>{names.get(r.source_order_id) ?? r.source_order_id}</td>
                <td>
                  {r.sku}
                  <small>{r.name}</small>
                </td>
                <td>{r.quantity}</td>
                <td>
                  {show
                    ? amount(r.price, currencies.get(r.source_order_id) ?? h.currency)
                    : 'Brak dostępu'}
                  {show && r.vat !== null ? ` / ${r.vat}%` : ''}
                </td>
                <td>
                  {show
                    ? amount(r.line_total, currencies.get(r.source_order_id) ?? h.currency)
                    : 'Brak dostępu'}
                </td>
                <td>
                  {r.components.map((c, i) => (
                    <small key={i}>
                      {c.product_id} × {c.quantity}
                    </small>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <details className="om-card">
        <summary>Pełne rezerwacje fizyczne · {evidence.physical.length}</summary>
        <p>
          Źródłowe rezerwacje i partie są zachowane w tym dowodzie. Samo połączenie nie wydaje
          towaru.
        </p>
        <div className="om-table">
          <table>
            <thead>
              <tr>
                <th>Źródło</th>
                <th>Produkt</th>
                <th>Magazyn / lokalizacja</th>
                <th>Partia</th>
                <th>Ilość / zeskanowano</th>
              </tr>
            </thead>
            <tbody>
              {evidence.physical.map((p, i) => (
                <tr key={i}>
                  <td>{names.get(p.source_order_id) ?? p.source_order_id}</td>
                  <td>{p.product_id}</td>
                  <td>
                    {p.warehouse_id}
                    <small>{p.location}</small>
                  </td>
                  <td>{p.layer_id ?? 'Bez warstwy partii'}</td>
                  <td>
                    {p.quantity} / {p.scanned}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}
function useMergeIO(readOnly: boolean, onError?: (message: string) => void) {
  const generation = useRef(0),
    gate = useRef(false),
    clear = useRef<() => void>(() => {}),
    pending = useRef<Attempt | null>(null);
  const [options, setOptions] = useState<Options | null>(null),
    [flags, setFlags] = useState<Flags | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [blocked, setBlocked] = useState(false);
  const flagsRef = useRef<Flags | null>(null);
  function deny(message: string) {
    ++generation.current;
    gate.current = false;
    pending.current = null;
    clear.current();
    flagsRef.current = null;
    setFlags(null);
    setOptions(null);
    setBusy(false);
    setBlocked(true);
    setError(message);
    onError?.(message);
  }
  function accept(d: Flags) {
    const old = flagsRef.current;
    if (!d.available) {
      clear.current();
      pending.current = null;
      setFlags(d);
      flagsRef.current = d;
      return false;
    }
    if (
      !d.can_read ||
      (old &&
        (old.current_role !== d.current_role ||
          (old.can_read_value && !d.can_read_value) ||
          (old.can_preview && !d.can_preview) ||
          (old.can_execute && !d.can_execute) ||
          (!old.read_only && d.read_only)))
    ) {
      deny('Dostęp zmienił się. Usunięto szkice i prywatne dowody; odczytaj ponownie dostęp.');
      return false;
    }
    flagsRef.current = d;
    setFlags(d);
    return true;
  }
  async function request<T>(path: string, e: number, method = 'GET', body?: unknown): Promise<T> {
    try {
      const d = await api<T>(path, method, body);
      if (e !== generation.current) throw new DOMException('Widok zmieniony', 'AbortError');
      return d;
    } catch (err) {
      if (e !== generation.current) throw new DOMException('Widok zmieniony', 'AbortError');
      throw err;
    }
  }
  async function run(fn: (e: number) => Promise<void>) {
    if (gate.current) return;
    gate.current = true;
    setBusy(true);
    setError('');
    const e = generation.current;
    try {
      await fn(e);
    } catch (err) {
      if (e !== generation.current) return;
      const message = err instanceof Error ? err.message : 'Nie udało się odczytać wyniku.';
      if (err instanceof ApiError && [401, 403, 423].includes(err.status)) deny(message);
      else {
        setError(message);
        onError?.(message);
      }
    } finally {
      if (e === generation.current) {
        gate.current = false;
        setBusy(false);
      }
    }
  }
  async function loadOptions() {
    if (pending.current) return;
    await run(async (e) => {
      const d = await request<Options>(prefix + '/options', e);
      if (!d.available) {
        clear.current();
        flagsRef.current = d;
        setFlags(d);
        setOptions(d);
        setBlocked(false);
        return;
      }
      if (!accept(d)) return;
      setOptions(d);
      setBlocked(false);
    });
  }
  useEffect(() => {
    ++generation.current;
    gate.current = false;
    void loadOptions();
    return () => {
      ++generation.current;
      gate.current = false;
      pending.current = null;
    };
  }, []);
  return {
    options,
    flags,
    busy,
    error,
    blocked,
    setError,
    clear,
    pending,
    gate,
    run,
    request,
    isCurrent: (e: number) => e === generation.current,
    accept,
    loadOptions,
    readable: !!flags?.available && !!flags.can_read && !blocked,
    previewable:
      !!flags?.available && flags.can_preview && !flags.read_only && !readOnly && !blocked,
    executable:
      !!flags?.available && flags.can_execute && !flags.read_only && !readOnly && !blocked,
  };
}
async function completeEvidence(
  io: ReturnType<typeof useMergeIO>,
  kind: Evidence['kind'],
  id: string,
  e: number,
): Promise<Evidence | null> {
  const base = prefix + '/' + (kind === 'preview' ? 'previews' : 'executions') + '/' + id;
  const detail = await io.request<Detail>(base, e);
  if (!io.accept(detail)) return null;
  const head = kind === 'preview' ? detail.preview : detail.execution;
  if (
    !head ||
    head.id !== id ||
    !uuid(head.target_order_id) ||
    !Number.isInteger(head.total) ||
    head.total < 1 ||
    head.total > 10000 ||
    !Number.isInteger(head.source_count) ||
    head.source_count < 2 ||
    head.source_count > 100 ||
    !Number.isInteger(head.physical_count) ||
    head.physical_count < 0 ||
    detail.meta.total !== head.total
  )
    throw Error('Nie potwierdzono pełnego zakresu połączenia.');
  async function pages<T>(suffix: string, total: number, max: number, key: (row: T) => string) {
    const all: T[] = [],
      seen = new Set<string>(),
      cursors = new Set<string>();
    let cursor: string | null = null;
    do {
      const page: Page<T> = await io.request<Page<T>>(
        base + suffix + '?' + new URLSearchParams({ limit: '100', ...(cursor ? { cursor } : {}) }),
        e,
      );
      if (!io.accept(page)) return null;
      if (page.meta.total !== total || page.data.length > 100)
        throw Error('Zakres strony nie odpowiada zamrożonemu podglądowi.');
      for (const row of page.data) {
        const k = key(row);
        if (seen.has(k)) throw Error('Powtórzona pozycja dowodu.');
        seen.add(k);
        all.push(row);
      }
      if (all.length > total || all.length > max)
        throw Error('Zakres dowodu przekracza limit; niczego nie obcięto.');
      cursor = page.meta.cursor;
      if (cursor) {
        if (!page.data.length || cursors.has(cursor) || cursors.size >= 100)
          throw Error('Nie odczytano pełnych stron dowodu.');
        cursors.add(cursor);
      }
    } while (cursor);
    if (all.length !== total) throw Error('Nie odczytano wszystkich pozycji dowodu.');
    return all;
  }
  const sources = await pages<Source>('/sources', head.source_count, 100, (s) => s.id);
  if (!sources) return null;
  for (const source of sources) assertDeliveryProjection(source.effective_delivery);
  const rows = await pages<Row>('/rows', head.total, 10000, (r) => String(r.index));
  if (!rows) return null;
  const physical = await pages<Physical>('/physical', head.physical_count, 10000, (p) =>
    JSON.stringify([p.source_order_id, p.product_id, p.warehouse_id, p.location, p.layer_id]),
  );
  if (!physical) return null;
  const ids = new Set(sources.map((s) => s.id));
  if (
    !ids.has(head.main_order_id) ||
    rows.some((r) => !ids.has(r.source_order_id)) ||
    physical.some((r) => !ids.has(r.source_order_id))
  )
    throw Error('Dowód zawiera pozycję spoza własnego zakresu źródeł.');
  const evidence: Evidence = {
    kind,
    head,
    sources,
    rows,
    physical,
    canValue: detail.can_read_value,
  };
  if (new TextEncoder().encode(JSON.stringify(evidence)).byteLength > 8388608)
    throw Error('Dowód przekracza 8 MiB. Zgoda pozostaje zablokowana; nie obcięto danych.');
  return evidence;
}
export function OrdersMergePanel(props: OrdersMergePanelProps) {
  return <MergePanelScope key={props.contextKey + ':' + props.readOnly} {...props} />;
}
function MergePanelScope({
  selectedIds,
  contextKey,
  readOnly,
  onOpenOrder,
  onError,
  onLockedChange,
}: OrdersMergePanelProps) {
  const io = useMergeIO(readOnly, onError);
  const actor = mergeActor(contextKey);
  const [initial] = useState(() => {try {return {intent: readMergeIntent(localStorage, actor), failed: false};} catch {return {intent: null, failed: true};}});
  const [storageFailed, setStorageFailed] = useState(initial.failed);
  const [main, setMain] = useState(''),
    [mode, setMode] = useState<Mode>('technical_merge'),
    [sum, setSum] = useState(false),
    [labels, setLabels] = useState<
      { id: string; number: string; customer_name: string; version: string | number }[]
    >([]),
    [loadedScope, setLoadedScope] = useState(''),
    [evidence, setEvidence] = useState<Evidence | null>(null),
    [head, setHead] = useState<{ kind: Evidence['kind']; id: string } | null>(null),
    [consent, setConsent] = useState(false),
    [receiverConsent, setReceiverConsent] = useState(false),
    [attempt, setAttempt] = useState<Attempt | null>(initial.intent),
    [status, setStatus] = useState(''),
    [history, setHistory] = useState<HistoryHead[]>([]),
    [historyCursor, setHistoryCursor] = useState<string | null>(null),
    [historyLoaded, setHistoryLoaded] = useState(false);
  const scope = JSON.stringify([...selectedIds].sort()),
    scopeRef = useRef(scope);
  scopeRef.current = scope;
  const attemptRef = io.pending,
    locked = io.busy || !!attempt || storageFailed;
  useEffect(() => {
    const update = () => {try {const v = readMergeIntent(localStorage, actor); io.pending.current = v; setAttempt(v); setStorageFailed(false);} catch {setStorageFailed(true);}};
    update(); window.addEventListener('storage', update); return () => window.removeEventListener('storage', update);
  }, [actor]);
  io.clear.current = () => {
    setMain('');
    setLabels([]);
    setLoadedScope('');
    setEvidence(null);
    setHead(null);
    setConsent(false);
    setReceiverConsent(false);
    try {const v = readMergeIntent(localStorage, actor); setAttempt(v); io.pending.current = v;} catch {setStorageFailed(true);}
    setStatus('');
    setHistory([]);
    setHistoryCursor(null);
    setHistoryLoaded(false);
  };
  useEffect(() => {
    onLockedChange?.(locked);
    return () => onLockedChange?.(false);
  }, [locked, onLockedChange]);
  useEffect(() => {
    if (attemptRef.current) return;
    setMain('');
    setLabels([]);
    setLoadedScope('');
    setEvidence(null);
    setHead(null);
    setConsent(false);
    setReceiverConsent(false);
    setStatus('');
  }, [scope]);
  const validSelection =
    selectedIds.length >= 2 &&
    selectedIds.length <= 100 &&
    new Set(selectedIds).size === selectedIds.length &&
    selectedIds.every(uuid);
  const samePreview =
    !!evidence &&
    evidence.kind === 'preview' &&
    JSON.stringify(evidence.sources.map((s) => s.id).sort()) === scope &&
    evidence.head.main_order_id === main &&
    evidence.head.merge_mode === mode &&
    evidence.head.sum_delivery_costs === sum;
  function change(fn: () => void) {
    if (locked || io.gate.current || attemptRef.current) return;
    fn();
    setEvidence(null);
    setHead(null);
    setConsent(false);
    setReceiverConsent(false);
    setStatus('');
  }
  async function loadSelection() {
    if (!io.readable || !validSelection || locked) return;
    const frozen = scope;
    await io.run(async (e) => {
      const results: typeof labels = [];
      for (let index = 0; index < selectedIds.length; index += 4) {
        const chunk = selectedIds.slice(index, index + 4);
        const got = await Promise.all(
          chunk.map((id) =>
            io.request<{
              id: string;
              number: string;
              customer_name: string;
              version: string | number;
            }>('/orders/' + id, e),
          ),
        );
        for (let i = 0; i < got.length; i++) {
          const r = got[i];
          if (r.id !== chunk[i] || !/^[1-9][0-9]*$/.test(String(r.version)))
            throw Error('Nie potwierdzono wybranych własnych zamówień.');
          results.push({
            id: r.id,
            number: r.number,
            customer_name: r.customer_name,
            version: r.version,
          });
        }
      }
      if (scopeRef.current !== frozen) return;
      setLabels(results);
      setLoadedScope(frozen);
      setMain('');
      setEvidence(null);
      setHead(null);
      setConsent(false);
      setReceiverConsent(false);
      setStatus(
        'Odczytano wybrane zamówienia. Wybierz główne jawnie; serwer zamrozi bieżące dane przy podglądzie.',
      );
    });
  }
  async function read(kind: Evidence['kind'], id: string) {
    if (!io.readable || io.busy) return;
    await io.run(async (e) => {
      setEvidence(null);
      setConsent(false);
      setReceiverConsent(false);
      setHead({ kind, id });
      const d = await completeEvidence(io, kind, id, e);
      if (d) setEvidence(d);
    });
  }
  async function submit(a: Attempt) {
    if (
      io.gate.current ||
      (attemptRef.current && attemptRef.current !== a) ||
      (a.kind === 'preview' ? !io.previewable : !io.executable)
    )
      return;
    await io.run(async (e) => withMergeCustodyLock(actor, async () => {
      await identity(e, true);
      if (!readMergeIntent(localStorage, actor)) retainMergeIntent(localStorage, a);
      assertHeldMergeIntent(localStorage, a);
      attemptRef.current = a;
      setAttempt(a);
      setConsent(false);
      setReceiverConsent(false);
      try {
        const d = await io.request<Detail>(
          prefix + (a.kind === 'preview' ? '/previews' : '/execute'),
          e,
          'POST',
          JSON.parse(a.serialized),
        );
        if (!io.accept(d)) return;
        const h = a.kind === 'preview' ? d.preview : d.execution;
        const body = JSON.parse(a.serialized) as {
          preview_id?: string;
          scope_hash?: string;
          main_order_id?: string;
          merge_mode?: Mode;
          sum_delivery_costs?: boolean;
        };
        if (
          !h ||
          !uuid(h.id) ||
          !uuid(h.target_order_id) ||
          (a.kind === 'execute' &&
            (h.preview_id !== body.preview_id || h.scope_hash !== body.scope_hash)) ||
          (a.kind === 'preview' &&
            (h.main_order_id !== body.main_order_id ||
              h.merge_mode !== body.merge_mode ||
              h.sum_delivery_costs !== body.sum_delivery_costs))
        )
          throw Error('Odpowiedź nie potwierdza dokładnego wyniku; zachowano próbę.');
        setHead({ kind: a.kind === 'preview' ? 'preview' : 'execution', id: h.id });
        setEvidence(null);
        setStatus(
          a.kind === 'preview'
            ? 'Trwały podgląd zapisany. Odczytujemy pełny zakres przed zgodą.'
            : 'Połączenie zapisane. Odczytujemy niezmienny wynik i pochodzenie źródeł.',
        );
        await reconcile(a, e, h.id);
      } catch (err) {
        if (!io.isCurrent(e)) return;
        if (attemptRef.current === a) {
          setStatus(
            'Niepewny wynik. Zachowano oryginalną treść i klucz także po odświeżeniu. Odczytaj oryginalny wynik; nie wykonano ponowienia.',
          );
        }
        throw err;
      }
    }));
  }
  async function identity(e: number, write = false) {
    const me = await io.request<any>('/auth/me', e);
    if (me.user?.tenant_id !== actor.split(':')[0] || me.user?.id !== actor.split(':')[1] || me.user?.role !== contextKey.split(':')[2] || typeof me.restore_preview !== 'boolean' ||
      (write && (readOnly || me.restore_preview !== false || me.read_only === true || me.user.role !== 'admin')))
      throw Error('Nie można potwierdzić bieżących uprawnień do zachowanej próby.');
  }
  async function reconcile(a: Attempt, e: number, acknowledgedId?: string) {
    assertHeldMergeIntent(localStorage, a); await identity(e);
    const b = JSON.parse(a.serialized);
    const d = await io.request<Detail>(prefix + '/commands/' + b.client_key + '?operation=' + a.kind, e);
    if (!io.accept(d)) return;
    const h = verifyMergeCommand(d, a);
    if (acknowledgedId && h.id !== acknowledgedId) throw Error('Oryginalny wynik różni się od potwierdzonego zapisu.');
    const kind = a.kind === 'preview' ? 'preview' : 'execution';
    const full = await completeEvidence(io, kind, h.id, e);
    if (!full) return;
    if (JSON.stringify(full.sources.map(s => s.id).sort()) !== JSON.stringify([...a.sourceIds].sort())) throw Error('Oryginalny wynik ma inny zakres źródeł.');
    const original = (d as any)[kind];
    if (full.head.scope_hash !== original.scope_hash || full.head.target_order_id !== original.target_order_id) throw Error('Odczyt dowodu różni się od oryginalnej komendy.');
    // A restored copy can display history, but cannot release custody of the original operation.
    await identity(e, true); assertHeldMergeIntent(localStorage, a); clearMergeIntent(localStorage, a);
    attemptRef.current = null; setAttempt(null); setEvidence(full); setHead({kind, id: h.id});
    setStatus('Odczytano i potwierdzono oryginalny wynik. Nie wysłano ponownej operacji.');
  }
  async function recover(a: Attempt) {
    if (!io.readable || io.busy || readOnly || storageFailed) return;
    await io.run(e => withMergeCustodyLock(actor, () => reconcile(a, e)));
  }
  function createPreview() {
    if (
      !io.previewable ||
      locked ||
      !validSelection ||
      loadedScope !== scope ||
      !selectedIds.includes(main)
    )
      return;
    const body = {
      client_key: crypto.randomUUID(),
      main_order_id: main,
      order_ids_to_merge: selectedIds.filter((id) => id !== main).sort(),
      merge_mode: mode,
      sum_delivery_costs: sum,
    };
    const serialized = JSON.stringify(body);
    if (
      new TextEncoder().encode(serialized).byteLength > (io.options?.limits.request_bytes ?? 65536)
    ) {
      io.setError('Zakres przekracza limit żądania; nie obcięto wyboru.');
      return;
    }
    void submit({ schema: 'order-merge-custody/v1', actor, kind: 'preview', serialized, sourceIds: [...selectedIds] });
  }
  function execute() {
    if (
      !io.executable ||
      locked ||
      !samePreview ||
      !evidence?.head.ready ||
      !consent ||
      (evidence.head.receiver_conflict && !receiverConsent)
    )
      return;
    const body = {
      client_key: crypto.randomUUID(),
      preview_id: evidence.head.id,
      scope_hash: evidence.head.scope_hash,
      confirmed: true,
      ...(evidence.head.receiver_conflict ? { confirmed_receiver_selection: true } : {}),
    };
    void submit({
      schema: 'order-merge-custody/v1', actor,
      kind: 'execute',
      serialized: JSON.stringify(body),
      sourceIds: evidence.sources.map((s) => s.id),
    });
  }
  async function loadHistory(more = false) {
    if (!io.readable || io.busy || (more && !historyCursor)) return;
    await io.run(async (e) => {
      const d = await io.request<Page<HistoryHead>>(
        prefix +
          '/history?' +
          new URLSearchParams({
            limit: '25',
            ...(more && historyCursor ? { cursor: historyCursor } : {}),
          }),
        e,
      );
      if (!io.accept(d)) return;
      if (
        d.data.length > 25 ||
        (more && d.meta.cursor === historyCursor) ||
        (!d.data.length && d.meta.cursor)
      )
        throw Error('Nieprawidłowa strona historii.');
      setHistory((old) =>
        more
          ? [...old, ...d.data.filter((r) => !old.some((o) => o.id === r.id && o.kind === r.kind))]
          : d.data,
      );
      setHistoryCursor(d.meta.cursor);
      setHistoryLoaded(true);
    });
  }
  function openOrder(id: string) {
    if (io.readable && !locked && !io.gate.current && !attemptRef.current && uuid(id))
      onOpenOrder(id);
  }
  return (
    <section className="order-merges" aria-label="Łączenie zamówień">
      <div className="om-heading">
        <div>
          <h2>Łączenie zamówień</h2>
          <p>
            Jawny wybór źródeł, pełny podgląd i osobne zatwierdzenie. Bez wysyłania zmian do kanału
            sprzedaży.
          </p>
        </div>
        <button className="button" disabled={locked} onClick={() => void io.loadOptions()}>
          Odśwież dostęp
        </button>
      </div>
      {io.error && (
        <p className="om-error" role="alert">
          {io.error}
        </p>
      )}
      {status && (
        <p className="om-status" role="status">
          {status}
        </p>
      )}
      {io.blocked && (
        <p className="om-error">
          Dostęp utracony. Usunięto prywatne dane i dokładne próby z tego widoku.
        </p>
      )}
      {!io.options && !io.blocked && <p>Odczytywanie dostępności…</p>}
      {io.options && !io.options.available && (
        <p className="om-hint">
          Ta kopia nie obsługuje łączenia zamówień. Istniejące zamówienia pozostają dostępne osobno.
        </p>
      )}
      {io.readable && (
        <>
          <p className="om-hint">
            Do operacji wybierz 2–100 własnych zamówień. Podgląd pokaże blokady realizacji, danych i
            płatności; źródła nigdy nie są usuwane z audytu. Płatności i rezerwacje nie są tworzone
            po raz drugi.
          </p>
          {(!io.previewable || !io.executable) && (
            <p className="om-hint">
              Dostępny odczyt historii. Tworzenie podglądu i zapis wymagają bieżących uprawnień;
              kopia odtworzona pozostaje tylko do odczytu.
            </p>
          )}
          {attempt && (
            <div className="om-pending" role="status">
              <strong>
                {io.busy ? 'Trwa dokładna próba.' : 'Niepewny wynik — zatrzymano nowe zapisy.'}
              </strong>
              <p>
                Próba dotyczy {attempt.sourceIds.length} zapisanych źródeł. Zmiana bieżącego wyboru
                nie zmienia tej treści. Oryginalna treść i klucz pozostają zachowane po odświeżeniu.
                Brak wyniku w odczycie nie potwierdza wycofania operacji i nie odblokowuje nowego zapisu.
              </p>
              <button
                className="button"
                disabled={
                  io.busy || readOnly || storageFailed || !io.readable
                }
                onClick={() => void recover(attempt)}
              >
                Odczytaj oryginalny wynik
              </button>
            </div>
          )}
          {storageFailed && <p role="alert">Nie można bezpiecznie odczytać zapisanej próby. Nowe zapisy są zablokowane.</p>}
          <h3>Nowe połączenie · wybrano {selectedIds.length}</h3>
          {!validSelection && (
            <p>
              Wybierz od 2 do 100 unikalnych zamówień na liście. Historia jest dostępna także bez
              wyboru.
            </p>
          )}
          <div className="om-actions">
            <button
              className="button"
              disabled={!validSelection || locked}
              onClick={() => void loadSelection()}
            >
              Odczytaj wybrane zamówienia
            </button>
          </div>
          <div className="om-grid">
            <label>
              Główne zamówienie
              <select
                value={main}
                disabled={locked || !io.previewable || loadedScope !== scope}
                onChange={(e) => change(() => setMain(e.target.value))}
              >
                <option value="">— Wybierz główne jawnie —</option>
                {labels.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.number} · {o.customer_name} · wersja {o.version}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Sposób połączenia
              <select
                value={mode}
                disabled={locked || !io.previewable}
                onChange={(e) => change(() => setMode(e.target.value as Mode))}
              >
                <option value="technical_merge">
                  Nowe zamówienie techniczne · zachowaj źródła w historii
                </option>
                <option value="into_main_order">Do głównego · pozostałe źródła do archiwum</option>
              </select>
            </label>
            <label>
              Koszt dostawy
              <select
                value={sum ? 'sum' : 'main'}
                disabled={locked || !io.previewable}
                onChange={(e) => change(() => setSum(e.target.value === 'sum'))}
              >
                <option value="main">Tylko z głównego zamówienia</option>
                <option value="sum">Suma kosztów wszystkich źródeł</option>
              </select>
            </label>
          </div>
          <p className="om-hint">
            Główne zamówienie wskazuje odbiorcę i dane dostawy. Różnice nie są rozstrzygane
            automatycznie. Źródłowe prywatne linki nie przekierowują do innego kupującego.
          </p>
          <button
            className="button primary"
            disabled={
              !io.previewable || locked || !validSelection || loadedScope !== scope || !main
            }
            onClick={createPreview}
          >
            Przygotuj pełny podgląd
          </button>
          {head && !evidence && (
            <div className="om-actions">
              <button
                className="button"
                disabled={io.busy}
                onClick={() => void read(head.kind, head.id)}
              >
                Odczytaj pełny zapisany zakres ponownie
              </button>
              <p>Zgoda jest zablokowana do odczytu wszystkich stron.</p>
            </div>
          )}
          {evidence && (
            <>
              <MergeEvidence evidence={evidence} canValue={io.flags?.can_read_value === true}
                onOpenOrder={openOrder} openBlocked={locked || io.busy || !io.readable} />
              {evidence.kind === 'preview' && (
                <>
                  {!samePreview && (
                    <p className="om-hint">
                      To zapisany podgląd historyczny. Nowy zapis wymaga zgodnego bieżącego wyboru i
                      ustawień.
                    </p>
                  )}
                  {evidence.head.receiver_conflict && (
                    <label className="om-check">
                      <input
                        type="checkbox"
                        checked={receiverConsent}
                        disabled={!samePreview || locked || !io.executable}
                        onChange={(e) => {
                          setReceiverConsent(e.target.checked);
                          setConsent(false);
                        }}
                      />
                      <span>
                        Potwierdzam wybór odbiorcy i danych dostawy z głównego{' '}
                        {evidence.sources.find((s) => s.id === evidence.head.main_order_id)?.number}
                        . Sprawdziłem różne dane pozostałych źródeł.
                      </span>
                    </label>
                  )}
                  <label className="om-check">
                    <input
                      type="checkbox"
                      checked={consent}
                      disabled={
                        !samePreview ||
                        !evidence.head.ready ||
                        locked ||
                        !io.executable ||
                        (evidence.head.receiver_conflict && !receiverConsent)
                      }
                      onChange={(e) => setConsent(e.target.checked)}
                    />
                    <span>
                      Potwierdzam dokładnie te {evidence.head.source_count} zamówienia i{' '}
                      {evidence.head.total} pozycji, wybrany tryb, odbiorcę, dostawę oraz pokazany
                      bilans.{' '}
                      {evidence.head.merge_mode === 'technical_merge'
                        ? 'Realizacja i rezerwacje przejdą do nowego zamówienia technicznego; źródła pozostaną dostępne w historii.'
                        : 'Pozostałe źródła zostaną zarchiwizowane, a realizacja przejdzie do głównego zamówienia.'}{' '}
                      Nie zlecam płatności, refundu ani kontaktu z dostawcą.
                    </span>
                  </label>
                  <button
                    className="button primary"
                    disabled={
                      !io.executable ||
                      locked ||
                      !samePreview ||
                      !evidence.head.ready ||
                      !consent ||
                      (evidence.head.receiver_conflict && !receiverConsent)
                    }
                    onClick={execute}
                  >
                    Zatwierdź połączenie
                  </button>
                </>
              )}
              {evidence.kind === 'execution' && (
                <button
                  className="button primary"
                  disabled={locked}
                  onClick={() => openOrder(evidence.head.target_order_id)}
                >
                  Otwórz wynikowe zamówienie
                </button>
              )}
              <details>
                <summary>Dowód operacji</summary>
                <p>
                  Identyfikator {evidence.head.id} · zakres {evidence.head.scope_hash} ·{' '}
                  {date(evidence.head.created_at)}
                </p>
              </details>
            </>
          )}
          <section className="om-card">
            <h3>Historia połączeń</h3>
            <div className="om-actions">
              <button className="button" disabled={io.busy} onClick={() => void loadHistory()}>
                Odczytaj historię
              </button>
              {historyCursor && (
                <button
                  className="button"
                  disabled={io.busy}
                  onClick={() => void loadHistory(true)}
                >
                  Odczytaj kolejną stronę historii
                </button>
              )}
            </div>
            {historyLoaded && !history.length && (
              <p role="status">Odczyt zakończony. Brak połączeń.</p>
            )}
            <div className="om-history">
              {history.map((h) => (
                <button
                  className="button"
                  key={h.kind + ':' + h.id}
                  disabled={io.busy}
                  onClick={() => void read(h.kind, h.id)}
                >
                  {date(h.created_at)} · {h.kind === 'preview' ? 'Podgląd' : 'Zapisane połączenie'}{' '}
                  · {modeNames[h.merge_mode]} · {h.source_count} źródeł / {h.total} pozycji
                </button>
              ))}
            </div>
          </section>
        </>
      )}
    </section>
  );
}
export function OrdersMergeLineage(props: OrdersMergeLineageProps) {
  return (
    <MergeLineageScope
      key={props.contextKey + ':' + props.readOnly + ':' + props.orderId}
      {...props}
    />
  );
}
function MergeLineageScope({ orderId, readOnly, onOpenOrder }: OrdersMergeLineageProps) {
  const io = useMergeIO(readOnly);
  const [data, setData] = useState<Lineage | null>(null),
    [loaded, setLoaded] = useState(false);
  io.clear.current = () => {
    setData(null);
    setLoaded(false);
  };
  async function load() {
    if (!io.readable || io.busy || !uuid(orderId)) return;
    await io.run(async (e) => {
      const d = await io.request<Lineage>(prefix + '/orders/' + orderId + '/lineage', e);
      if (!io.accept(d)) return;
      if (
        d.order_id !== orderId ||
        !uuid(d.owner_order_id) ||
        d.claims.length > (io.options?.limits.executions ?? 2000) ||
        (d.origin && d.origin.items.length > 10000) ||
        (d.created_by &&
          (!uuid(d.created_by.id) ||
            !uuid(d.created_by.main_order_id) ||
            d.created_by.merge_mode !== 'technical_merge' ||
            !Number.isFinite(Date.parse(d.created_by.created_at)) ||
            d.created_by.sources.length < 2 ||
            d.created_by.sources.length > 100 ||
            d.created_by.sources.some((s) => !uuid(s.id) || typeof s.number !== 'string') ||
            new Set(d.created_by.sources.map((s) => s.id)).size !== d.created_by.sources.length))
      )
        throw Error('Nie potwierdzono pełnego pochodzenia zamówienia.');
      if (d.origin) assertDeliveryProjection(d.origin.header.effective_delivery);
      setData(d);
      setLoaded(true);
    });
  }
  return (
    <section className="order-merges" aria-label="Pochodzenie połączonego zamówienia">
      <h3>Połączenia i pochodzenie</h3>
      {io.error && (
        <p className="om-error" role="alert">
          {io.error}
        </p>
      )}
      {io.blocked && <p>Dostęp utracony; usunięto poprzedni odczyt.</p>}
      {io.options && !io.options.available && <p>Ta kopia nie zawiera historii połączeń.</p>}
      {io.readable && (
        <>
          <button className="button" disabled={io.busy} onClick={() => void load()}>
            Odczytaj pochodzenie zamówienia
          </button>
          {loaded && data && !data.claims.length && !data.origin && !data.created_by && (
            <p role="status">Odczyt zakończony. Zamówienie nie uczestniczyło w połączeniu.</p>
          )}
          {data && (
            <>
              {data.created_by && (
                <div className="om-card">
                  <h4>Utworzono z połączenia źródeł</h4>
                  <p>
                    {date(data.created_by.created_at)} · {modeNames[data.created_by.merge_mode]}
                  </p>
                  <small>Wykonanie {data.created_by.id}</small>
                  <div className="om-actions">
                    {data.created_by.sources.map((s) => (
                      <button
                        key={s.id}
                        className="button"
                        disabled={io.busy}
                        onClick={() => {
                          if (io.readable && !io.gate.current) onOpenOrder(s.id);
                        }}
                      >
                        Otwórz źródło {s.number}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {data.closed_source && (
                <p className="om-hint">
                  Źródło zarchiwizowano po połączeniu. Zachowano audyt i dawny zapis; to nie
                  anulowanie ani refund. Realizacja należy do zamówienia wynikowego.
                </p>
              )}
              {data.owner_order_id !== orderId && (
                <button
                  className="button"
                  disabled={io.busy}
                  onClick={() => {
                    if (io.readable && !io.gate.current) onOpenOrder(data.owner_order_id);
                  }}
                >
                  Otwórz zamówienie obsługujące realizację
                </button>
              )}
              <div className="om-history">
                {data.claims.map((c, i) => (
                  <div className="om-card" key={c.execution_id + ':' + c.source_order_id + ':' + i}>
                    <p>{modeNames[c.merge_mode]}</p>
                    <div className="om-actions">
                      <button
                        className="button"
                        disabled={io.busy}
                        onClick={() => {
                          if (io.readable && !io.gate.current) onOpenOrder(c.source_order_id);
                        }}
                      >
                        Otwórz źródło {c.source_order_id}
                      </button>
                      <button
                        className="button"
                        disabled={io.busy}
                        onClick={() => {
                          if (io.readable && !io.gate.current) onOpenOrder(c.target_order_id);
                        }}
                      >
                        Otwórz wynik {c.target_order_id}
                      </button>
                    </div>
                    <small>Wykonanie {c.execution_id}</small>
                  </div>
                ))}
              </div>
              {data.origin && (
                <details className="om-card">
                  <summary>
                    Oryginalny zapis {data.origin.header.number} · wersja{' '}
                    {data.origin.header.version}
                  </summary>
                  <p>
                    {data.origin.header.customer_name} · {data.origin.header.email} ·{' '}
                    {data.origin.header.source} · ID źródła{' '}
                    {data.origin.header.external_id ?? 'brak'}
                  </p>
                  <Address address={data.origin.header.address} />
                  <DeliveryView value={data.origin.header.effective_delivery} />
                  <BalanceView
                    balance={data.origin.header.payment_balance}
                    canValue={io.flags?.can_read_value === true}
                  />
                  <div className="om-table">
                    <table>
                      <thead>
                        <tr>
                          <th>Oryginalna pozycja</th>
                          <th>Ilość</th>
                          <th>Cena / VAT</th>
                          <th>Wartość</th>
                          <th>Skład</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.origin.items.map((i) => (
                          <tr key={i.id}>
                            <td>
                              {i.sku}
                              <small>{i.name}</small>
                            </td>
                            <td>{i.quantity}</td>
                            <td>
                              {io.flags?.can_read_value
                                ? amount(i.price, data.origin!.header.currency)
                                : 'Brak dostępu'}
                              {io.flags?.can_read_value && i.vat !== null ? ` / ${i.vat}%` : ''}
                            </td>
                            <td>
                              {io.flags?.can_read_value
                                ? amount(i.line_total, data.origin!.header.currency)
                                : 'Brak dostępu'}
                            </td>
                            <td>
                              {i.components.map((c, n) => (
                                <small key={n}>
                                  {c.product_id} × {c.quantity}
                                </small>
                              ))}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
