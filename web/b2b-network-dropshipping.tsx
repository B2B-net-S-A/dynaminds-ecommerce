import { useEffect, useRef, useState } from 'react';
import { B2bDropshipCustomerTracking } from './b2b-network-lifecycle';
import { api, ApiError, date, statusNames } from './api';
import './b2b-network-dropshipping.css';

type Flags = {
  available: boolean;
  read_only: boolean;
  current_role: string;
  can_read: boolean;
  can_manage: boolean;
  can_read_value: boolean;
};
type Receiver = { customer_name: string; email: string; address: Record<string, unknown> };
type Balance = {
  currency: string;
  received: number | string;
  refunded: number | string;

  amount_due: number | string;
  overpayment: number | string;
};
type Retail = {
  currency: string;
  total_minor?: string;
  shipping_minor?: string;
  payment_mode: string;
  payment_balance?: Balance | null;
};
type Mapping = {
  catalog_item_id: string;
  source_product_id: string;
  sku: string;
  name: string;
  version: number;
};
type SourceLine = {
  customer_item_id: string;
  product_id: string;
  sku: string;
  name: string;
  quantity: number;
  scanned: number;
  committed_quantity: number;
  remaining_quantity: number;
  vat: number;
  unit_price_minor?: string;
  line_total_minor?: string;
  currency: string;
  components: {
    product_id: string;
    sku: string;
    name: string;
    quantity: number;
    mappings: Mapping[];
  }[];
};
type Source = {
  id: string;
  number: string;
  version: string;
  status: string;
  currency: string;
  receiver: Receiver;
  retail: Retail;
  lines: SourceLine[];
  fulfillment_basis?: 'external_intent';
  intent_version?: number;
};
type SourceHead = { id: string; number: string; status: string; version: string; currency: string };
type Item = {
  sku?: string;
  name?: string;
  currency?: string;
  vat?: number;
  unit_price_minor?: string;
  line_total_minor?: string;
  original_quantity?: number;
  customer_item_id: string;
  quantity: number;
  mappings: {
    product_id: string;
    catalog_item_id: string;
    product_sku?: string;
    product_name?: string;
    source_sku?: string;
    source_name?: string;
    source_product_id?: string;
    quantity?: number;
  }[];
};
type Wholesale = {
  currency: string;
  total_minor?: string;
  shipping_minor?: string;
  payment_mode: 'prepaid';
  bill_to: { name: string; email: string; tax_id: string; address: Record<string, unknown> };
  items: {
    source_product_id: string;
    sku: string;
    name: string;
    vat: number;
    quantity: number;
    unit_gross_minor?: string;
    line_total_minor?: string;
  }[];
};
type Quote = {
  id: string;
  customer_order_id: string;
  customer_number: string;
  scope_hash: string;
  expires_at: string;
  created_at: string;
  receiver: Receiver;
  retail: Retail;
  wholesale: Wholesale;
  items: Item[];
  ready: boolean;
  blockers: string[];
  current_order_id: string | null;
  can_checkout: boolean;
};
type DropOrder = {
  id: string;
  quote_id: string;
  customer_order_id: string;
  customer_number: string;
  supplier_order_id: string;
  supplier_number: string;
  version: number;
  state: 'ordered' | 'cancelled';
  fulfillment_basis?: 'external_intent';
  intent_version?: number;
  receiver: Receiver;
  retail: Retail;
  wholesale: Wholesale;
  items: Item[];
  created_at: string;
  cancelled_at: string | null;
  can_cancel: boolean;
  can_reconcile: boolean;
  reconciled: boolean;
  customer_tracking?: { carrier: string; tracking_number: string; dispatched_at: string; copied_at: string }[];
  fulfillment: {
    status: string;
    payment_balance?: Balance | null;
    shipments: {
      carrier: string;
      tracking_number: string;
      status: string;
      mode: string;
      dispatched_at: string | null;
    }[];
    historical: boolean;
    read_only: boolean;
  };
};
type Page<T> = Flags & { data: T[]; meta: { total?: number; cursor: string | null } };
type Options = Flags & {
  limits: {
    items: number;
    products: number;
    quantity: number;
    page_rows: number;
    quotes: number;
    orders: number;
    proof_bytes: number;
  };
  payment_mode: 'prepaid';
  receiver_source: 'customer_order_snapshot';
  local_custody: 'released_unscanned_then_supplier_reserved';
};
type Attempt = {
  kind: 'quote' | 'checkout' | 'cancel' | 'reconcile';
  path: string;
  body: string;
  actor_role?: string;
};
type DraftLine = { quantity: string; mappings: Record<string, string> };

export type B2bNetworkDropshippingProps = {
  linkId: string;
  supplierName: string;
  contextKey: string;
  readOnly: boolean;
  onLockedChange?: (locked: boolean) => void;
  externalWriteBlocked?: boolean;
  guardFreshWrite?: (exactRetry?: boolean) => Promise<() => void>;
};

// Only exact write attempts survive an ordinary tab unmount. They contain IDs,
// quantities and a key, never a customer address. A different actor clears them.
const attempts = new Map<string, Attempt>();
let attemptActor = '';
function money(value: number | string | null | undefined, currency: string) {
  if (
    value == null ||
    (typeof value === 'number' && !Number.isSafeInteger(value)) ||
    !/^-?\d+$/.test(String(value))
  )
    return 'Brak danych';
  const amount = BigInt(value),
    absolute = amount < 0n ? -amount : amount;
  const whole = (absolute / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0');
  return `${amount < 0n ? '−' : ''}${whole},${String(absolute % 100n).padStart(2, '0')} ${currency}`;
}
const addressText = (address: Record<string, unknown>) =>
  ['street', 'postal_code', 'city', 'country', 'phone']
    .map((key) => (typeof address[key] === 'string' ? String(address[key]) : ''))
    .filter(Boolean)
    .join(' · ');

export function B2bNetworkDropshipping({
  linkId,
  supplierName,
  contextKey,
  readOnly,
  onLockedChange,
  externalWriteBlocked = false,
  guardFreshWrite,
}: B2bNetworkDropshippingProps) {
  const prefix = '/b2b/network/links/' + encodeURIComponent(linkId) + '/dropshipping';
  const scope = `${contextKey}:${readOnly}:${linkId}`;
  const [options, setOptions] = useState<Options | null>(null);
  const [flags, setFlags] = useState<Flags | null>(null);
  const [sources, setSources] = useState<Page<SourceHead> | null>(null);
  const [source, setSource] = useState<Source | null>(null);
  const [search, setSearch] = useState('');
  const [appliedSearch, setAppliedSearch] = useState('');
  const [draft, setDraft] = useState<Record<string, DraftLine>>({});
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quotes, setQuotes] = useState<Page<Quote> | null>(null);
  const [orders, setOrders] = useState<Page<DropOrder> | null>(null);
  const [order, setOrder] = useState<DropOrder | null>(null);
  const [consent, setConsent] = useState(false);
  const [receiverConsent, setReceiverConsent] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [cancelConsent, setCancelConsent] = useState(false);
  const [reconcileConsent, setReconcileConsent] = useState(false);
  const [pending, setPending] = useState<Attempt | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [blocked, setBlocked] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [revision, setRevision] = useState(0);
  const [tab, setTab] = useState<'new' | 'quotes' | 'orders'>('new');
  const epoch = useRef(0),
    gate = useRef(false),
    authority = useRef<Flags | null>(null);
  const boundScope = useRef(scope),
    currentScope = useRef(scope);
  currentScope.current = scope;
  const freshGate = useRef({ externalWriteBlocked, guardFreshWrite, readOnly });
  freshGate.current = { externalWriteBlocked, guardFreshWrite, readOnly };
  const current = (generation: number) =>
    epoch.current === generation && currentScope.current === boundScope.current;
  const visible = boundScope.current === scope;
  const canWrite =
    visible &&
    (!externalWriteBlocked || !!pending) &&
    !readOnly &&
    !blocked &&
    !!flags?.available &&
    !!flags?.can_manage &&
    !flags.read_only;
  const locked = busy || loading || !!pending || !visible;
  const financial = visible && !!flags?.can_read_value;

  function resetConsents() {
    setConsent(false);
    setReceiverConsent(false);
    setCancelConsent(false);
    setReconcileConsent(false);
  }
  function purge() {
    setSource(null);
    setSources(null);
    setDraft({});
    setQuote(null);
    setQuotes(null);
    setOrder(null);
    setOrders(null);
    resetConsents();
  }
  function remember(value: Attempt | null) {
    if (value) attempts.set(scope, value);
    else attempts.delete(scope);
    setPending(value);
  }
  function accept(response: Flags, generation: number) {
    if (!current(generation)) return false;
    const previous = authority.current;
    authority.current = response;
    setFlags(response);
    if (
      previous &&
      (previous.current_role !== response.current_role ||
        previous.can_read_value !== response.can_read_value)
    ) {
      purge();
      remember(null);
      throw new Error('Uprawnienia zmieniły się. Odczytaj ponownie ten zakres.');
    }
    return true;
  }
  function fail(error: unknown, generation: number) {
    if (!current(generation)) return;
    setError(error instanceof Error ? error.message : 'Nie udało się wykonać operacji.');
    if (error instanceof ApiError && [401, 403, 423].includes(error.status)) {
      purge();
      remember(null);
      setOptions(null);
      setFlags(null);
      authority.current = null;
      setBlocked(true);
    }
  }
  function release(generation: number) {
    if (current(generation)) {
      gate.current = false;
      setBusy(false);
    }
  }
  async function read<T extends Flags>(path: string, apply: (value: T) => void) {
    if (gate.current || !visible) return;
    const generation = epoch.current;
    gate.current = true;
    setBusy(true);
    setError('');
    try {
      const value = await api<T>(path);
      if (accept(value, generation)) apply(value);
    } catch (e) {
      fail(e, generation);
    } finally {
      release(generation);
    }
  }
  async function sourcePage(cursor?: string, term = appliedSearch) {
    const params = new URLSearchParams({
      limit: '25',
      ...(term ? { search: term } : {}),
      ...(cursor ? { cursor } : {}),
    });
    await read<Page<SourceHead>>(prefix + '/sources?' + params, (d) => {
      setSources(d);
      setAppliedSearch(term);
    });
  }
  async function history(kind: 'quotes' | 'orders', cursor?: string) {
    await read<Page<Quote> | Page<DropOrder>>(
      prefix +
        '/' +
        kind +
        '?' +
        new URLSearchParams({ limit: '25', ...(cursor ? { cursor } : {}) }),
      (d) => {
        if (kind === 'quotes') setQuotes(d as Page<Quote>);
        else setOrders(d as Page<DropOrder>);
      },
    );
  }
  async function openSource(id: string) {
    if (locked) return;
    await read<Flags & { source: Source }>(prefix + '/sources/' + encodeURIComponent(id), (d) => {
      setSource(d.source);
      setDraft({});
      setQuote(null);
      setOrder(null);
      resetConsents();
      setNotice('');
    });
  }
  function edit(lines: Record<string, DraftLine>) {
    if (locked) return;
    setDraft(lines);
    setQuote(null);
    resetConsents();
    setNotice('');
  }

  useEffect(() => {
    const generation = ++epoch.current;
    boundScope.current = scope;
    gate.current = false;
    authority.current = null;
    if (attemptActor !== contextKey || readOnly) {
      attempts.clear();
      attemptActor = contextKey;
    }
    setPending(readOnly ? null : (attempts.get(scope) ?? null));
    purge();
    setOptions(null);
    setFlags(null);
    setLoading(true);
    setBusy(false);
    setBlocked(false);
    setError('');
    setNotice('');
    setTab('new');
    setSearch('');
    setAppliedSearch('');
    void api<Options>(prefix + '/options')
      .then((d) => {
        if (!current(generation)) return;
        authority.current = d;
        setOptions(d);
        setFlags(d);
        const retained = attempts.get(scope);
        if (retained?.actor_role && retained.actor_role !== d.current_role) {
          attempts.delete(scope);
          setPending(null);
          setError(
            'Rola użytkownika zmieniła się. Dokładna próba została usunięta z pamięci; odczytaj historię dostawcy.',
          );
        }
      })
      .catch((e) => fail(e, generation))
      .finally(() => {
        if (current(generation)) setLoading(false);
      });
    return () => {
      ++epoch.current;
    };
  }, [scope, revision]);
  useEffect(() => {
    onLockedChange?.(busy || !!pending);
    return () => onLockedChange?.(false);
  }, [busy, pending, onLockedChange]);

  async function write(attempt: Attempt) {
    if (gate.current || !canWrite) return;
    const generation = epoch.current;
    const frozenAttempt: Attempt = {
      ...attempt,
      actor_role: attempt.actor_role ?? flags?.current_role,
    };
    gate.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    const retry = attempts.get(scope);
    try {
      if (retry && (retry.path !== attempt.path || retry.body !== attempt.body || retry.kind !== attempt.kind)) throw Error('Zachowaną próbę można ponowić wyłącznie z dokładną treścią.');
      if (freshGate.current.readOnly) throw Error('Kopia jest tylko do odczytu.');
      const fence = await freshGate.current.guardFreshWrite?.(!!retry);
      if (!current(generation)) return;
      if (!retry) {
        if (freshGate.current.externalWriteBlocked || freshGate.current.readOnly) throw Error('Inna operacja blokuje nowy zapis B2B.');
      }
      if (freshGate.current.readOnly) throw Error('Kopia jest tylko do odczytu.');
      fence?.();
      remember(frozenAttempt);
      const response = await api<Flags & { quote?: Quote; order?: DropOrder; reused: boolean }>(
        frozenAttempt.path,
        'POST',
        JSON.parse(frozenAttempt.body),
      );
      if (!accept(response, generation)) return;
      if (attempt.kind === 'quote') {
        if (!response.quote)
          throw new Error('Brak potwierdzenia wyceny w odpowiedzi. Zachowano dokładną próbę.');
        setQuote(response.quote);
        setOrder(null);
        resetConsents();
        setTab('new');
        setNotice(
          response.reused
            ? 'Odnaleziono wcześniej zapisaną wycenę. Sprawdź jej aktualny stan przed potwierdzeniem.'
            : 'Wycena zapisana. Sprawdź odbiorcę, wszystkie pozycje i warunki dostawcy.',
        );
      } else {
        if (!response.order)
          throw new Error('Brak potwierdzenia zamówienia w odpowiedzi. Zachowano dokładną próbę.');
        setOrder(response.order);
        setQuote(null);
        setSource(null);
        setDraft({});
        resetConsents();
        setTab('orders');
        setNotice(
          attempt.kind === 'checkout'
            ? 'Zamówienie u dostawcy zapisane. Dostawa jest do klienta; w Twoim magazynie nie powstało PZ.'
            : attempt.kind === 'cancel'
              ? 'Odczytano wynik anulowania zamówienia u dostawcy.'
              : 'Odczytano wynik uzgodnienia realizacji. Szczegóły poniżej pokazują stan zapisany w systemie.',
        );
      }
      remember(null);
    } catch (e) {
      if (!current(generation)) return;
      if (
        e instanceof ApiError &&
        e.status >= 400 &&
        e.status < 500 &&
        ![408, 425, 429].includes(e.status) &&
        !(attempt.kind === 'cancel' && e.status === 409)
      ) {
        remember(null);
        if (e.status === 409) {
          setQuote(null);
          resetConsents();
        }
      }
      fail(e, generation);
    } finally {
      release(generation);
    }
  }
  function createQuote() {
    if (!source || locked || !canWrite) return;
    try {
      if (
        source.fulfillment_basis === 'external_intent' &&
        (!Number.isInteger(source.intent_version) || Number(source.intent_version) < 1)
      )
        throw new Error('Brak aktualnej wersji intencji. Odczytaj zakres ponownie.');
      const items: Item[] = [];
      for (const line of source.lines) {
        const value = draft[line.customer_item_id];
        if (!value) continue;
        if (!/^[1-9]\d*$/.test(value.quantity))
          throw new Error(`Podaj całkowitą dodatnią ilość pozycji ${line.sku}.`);
        const quantity = Number(value.quantity);
        if (!Number.isSafeInteger(quantity) || quantity > line.remaining_quantity)
          throw new Error(
            `Ilość pozycji ${line.sku} przekracza pozostały zakres ${line.remaining_quantity}.`,
          );
        if (!line.components.length) throw new Error(`Brak fizycznego składu pozycji ${line.sku}.`);
        const mappings = line.components.map((component) => {
          const catalogId = value.mappings[component.product_id];
          if (!component.mappings.some((m) => m.catalog_item_id === catalogId))
            throw new Error(`Wybierz konkretny produkt dostawcy dla składnika ${component.sku}.`);
          return { product_id: component.product_id, catalog_item_id: catalogId };
        });
        items.push({ customer_item_id: line.customer_item_id, quantity, mappings });
      }
      if (!items.length) throw new Error('Wybierz co najmniej jedną pozycję zamówienia.');
      if (!options || items.length > options.limits.items)
        throw new Error(
          `Jedno zlecenie może obejmować maksymalnie ${options?.limits.items ?? 'dozwoloną liczbę'} pozycji. Wybór nie zostanie obcięty.`,
        );
      if (items.some((item) => item.quantity > options.limits.quantity))
        throw new Error(`Ilość jednej pozycji nie może przekraczać ${options.limits.quantity}.`);
      const productIds = new Set(
        items.flatMap((item) => item.mappings.map((mapping) => mapping.product_id)),
      );
      if (productIds.size > options.limits.products)
        throw new Error(
          `Wybrany skład obejmuje więcej niż ${options.limits.products} produktów fizycznych.`,
        );
      const attempt: Attempt = {
        kind: 'quote',
        path: prefix + '/quotes',
        body: JSON.stringify({
          client_key: crypto.randomUUID(),
          customer_order_id: source.id,
          ...(source.fulfillment_basis === 'external_intent'
            ? { fulfillment_basis: source.fulfillment_basis, intent_version: source.intent_version }
            : {}),
          items,
        }),
      };
      void write(attempt);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Niepoprawny wybór pozycji.');
    }
  }
  function checkout() {
    if (
      !quote ||
      locked ||
      !canWrite ||
      !quote.ready ||
      !quote.can_checkout ||
      !consent ||
      !receiverConsent
    )
      return;
    void write({
      kind: 'checkout',
      path: prefix + '/quotes/' + quote.id + '/checkout',
      body: JSON.stringify({
        client_key: crypto.randomUUID(),
        scope_hash: quote.scope_hash,
        confirmed: true,
        confirmed_receiver: true,
      }),
    });
  }
  function cancel() {
    if (!order || locked || !canWrite || !order.can_cancel || !cancelConsent) return;
    if (cancelReason.trim().length < 3 || cancelReason.trim().length > 1000) {
      setError('Podaj uzasadnienie anulowania od 3 do 1000 znaków.');
      return;
    }
    void write({
      kind: 'cancel',
      path: prefix + '/orders/' + order.id + '/cancel',
      body: JSON.stringify({
        client_key: crypto.randomUUID(),
        version: order.version,
        reason: cancelReason.trim(),
        confirmed: true,
      }),
    });
  }
  function reconcile() {
    if (!order || locked || !canWrite || !order.can_reconcile || !reconcileConsent) return;
    void write({
      kind: 'reconcile',
      path: prefix + '/orders/' + order.id + '/reconcile',
      body: JSON.stringify({
        client_key: crypto.randomUUID(),
        version: order.version,
        confirmed: true,
      }),
    });
  }

  return (
    <section className="network-dropshipping" aria-label="Dostawa B2B do klienta">
      <header>
        <h2>Dostawa do klienta · {supplierName}</h2>
        <p>
          Zleć dostawcy wybrane pozycje własnego zamówienia sprzedażowego. Odbiorcą paczki jest
          klient, a kupującym u dostawcy pozostaje Twoja firma.
        </p>
      </header>
      {visible && error && (
        <div className="drop-notice drop-error" role="alert">
          {error}
        </div>
      )}
      {visible && notice && (
        <div className="drop-notice" role="status">
          {notice}
        </div>
      )}
      {loading && <p role="status">Odczytywanie dostępu do dostawy bezpośredniej…</p>}
      {!loading && (!options || blocked) && (
        <button className="button" disabled={busy} onClick={() => setRevision((n) => n + 1)}>
          Odczytaj dostęp ponownie
        </button>
      )}
      {visible && options && !options.available && (
        <p>Dostawa bezpośrednia nie jest dostępna w tej kopii systemu.</p>
      )}
      {visible && options?.available && (
        <>
          {(readOnly || flags?.read_only) && (
            <p className="drop-notice">
              Tylko odczyt. Historia i szczegóły są dostępne; nie można składać nowych zleceń.
            </p>
          )}
          {!financial && (
            <p className="drop-notice">Kwoty i rozliczenia są ukryte dla tego dostępu.</p>
          )}
          {pending && (
            <div className="drop-notice" role="alert">
              <strong>Zachowano dokładną próbę zapisu.</strong>
              <p>
                Nie otrzymano potwierdzenia albo zapis jest obecnie zablokowany. Nowe zapisy są
                wstrzymane. Ponowienie użyje dokładnie tego samego klucza i zakresu. Nie składaj
                osobnego zamówienia. Po przeładowaniu aplikacji odczytaj historię, aby ustalić
                wynik.
              </p>
              <button
                className="button primary"
                disabled={busy || !canWrite}
                onClick={() => void write(pending)}
              >
                Ponów dokładnie tę samą próbę
              </button>
            </div>
          )}
          <nav className="drop-actions" aria-label="Dostawa do klienta — widoki">
            <button
              className={'button ' + (tab === 'new' ? 'primary' : '')}
              onClick={() => setTab('new')}
            >
              Nowe zlecenie
            </button>
            <button
              className={'button ' + (tab === 'quotes' ? 'primary' : '')}
              disabled={busy}
              onClick={() => {
                setTab('quotes');
                if (!quotes) void history('quotes');
              }}
            >
              Historia wycen
            </button>
            <button
              className={'button ' + (tab === 'orders' ? 'primary' : '')}
              disabled={busy}
              onClick={() => {
                setTab('orders');
                if (!orders) void history('orders');
              }}
            >
              Zlecenia dostawcy
            </button>
          </nav>
          {tab === 'new' && (
            <>
              <form
                className="drop-search"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!locked) void sourcePage(undefined, search.trim());
                }}
              >
                <label>
                  Znajdź własne zamówienie
                  <input
                    value={search}
                    maxLength={100}
                    disabled={locked}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Numer zamówienia"
                  />
                </label>
                <button className="button" disabled={locked}>
                  Odczytaj zamówienia
                </button>
              </form>
              {sources && (
                <>
                  <div className="drop-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>Zamówienie</th>
                          <th>Status</th>
                          <th>Waluta</th>
                          <th>Wybór</th>
                        </tr>
                      </thead>
                      <tbody>
                        {sources.data.map((s) => (
                          <tr key={s.id}>
                            <td>{s.number}</td>
                            <td>{statusNames[s.status] ?? s.status}</td>
                            <td>{s.currency}</td>
                            <td>
                              <button
                                className="button"
                                disabled={locked}
                                onClick={() => void openSource(s.id)}
                              >
                                Wybierz {s.number}
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {!sources.data.length && <p>Brak własnych zamówień w tym zakresie.</p>}
                  <Pagination
                    count={sources.data.length}
                    total={sources.meta.total}
                    cursor={sources.meta.cursor}
                    disabled={locked}
                    onFirst={() => void sourcePage()}
                    onNext={() => void sourcePage(sources.meta.cursor!)}
                  />
                </>
              )}
              {source && (
                <section className="drop-section">
                  <h3>Zamówienie klienta · {source.number}</h3>
                  <p>
                    {statusNames[source.status] ?? source.status} · wersja {source.version}
                  </p>
                  {source.fulfillment_basis === 'external_intent' && (
                    <p className="drop-notice">
                      Wyceniany zakres pochodzi z intencji zewnętrznej dla tego dostawcy. Nie wymaga
                      pierwotnej lokalnej rezerwacji. Wersja intencji: {source.intent_version}.
                    </p>
                  )}
                  <ReceiverView receiver={source.receiver} />
                  <RetailView
                    retail={source.retail}
                    currency={source.currency}
                    financial={financial}
                    balanceBasis="current"
                  />
                  <button
                    className="button"
                    disabled={locked}
                    onClick={() => void openSource(source.id)}
                  >
                    Odczytaj pozycje i dostępny zakres ponownie
                  </button>
                  <div className="drop-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>Wybierz</th>
                          <th>Pozycja klienta</th>
                          <th>Zamówiono / już zlecono</th>
                          <th>Pozostało</th>
                          {financial && (
                            <>
                              <th>Cena klienta brutto</th>
                              <th>Wartość pozycji klienta brutto</th>
                            </>
                          )}
                          <th>Zlecam jednostek pozycji</th>
                        </tr>
                      </thead>
                      <tbody>
                        {source.lines.map((line) => (
                          <tr key={line.customer_item_id}>
                            <td>
                              <input
                                aria-label={'Wybierz pozycję ' + line.sku}
                                type="checkbox"
                                checked={!!draft[line.customer_item_id]}
                                disabled={locked || !canWrite || line.remaining_quantity < 1}
                                onChange={(e) => {
                                  const next = { ...draft };
                                  if (e.target.checked)
                                    next[line.customer_item_id] = { quantity: '1', mappings: {} };
                                  else delete next[line.customer_item_id];
                                  edit(next);
                                }}
                              />
                            </td>
                            <td>
                              {line.name}
                              <small>{line.sku}</small>
                              <details>
                                <summary>Identyfikator pozycji</summary>
                                <code>{line.customer_item_id}</code>
                              </details>
                            </td>
                            <td>
                              {line.quantity} / {line.committed_quantity}
                              <small>Skanowano: {line.scanned}</small>
                            </td>
                            <td>{line.remaining_quantity}</td>
                            {financial && (
                              <>
                                <td>
                                  {money(line.unit_price_minor, line.currency)}
                                  <small>VAT {line.vat}%</small>
                                </td>
                                <td>{money(line.line_total_minor, line.currency)}</td>
                              </>
                            )}
                            <td>
                              <input
                                type="text"
                                inputMode="numeric"
                                aria-label={'Ilość pozycji ' + line.sku}
                                value={draft[line.customer_item_id]?.quantity ?? ''}
                                disabled={locked || !draft[line.customer_item_id] || !canWrite}
                                onChange={(e) =>
                                  edit({
                                    ...draft,
                                    [line.customer_item_id]: {
                                      ...draft[line.customer_item_id],
                                      quantity: e.target.value,
                                    },
                                  })
                                }
                              />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {source.lines
                    .filter((line) => draft[line.customer_item_id])
                    .map((line) => (
                      <div key={line.customer_item_id} className="drop-mappings">
                        <h4>Produkty dostawcy dla pozycji {line.sku}</h4>
                        <p>
                          Cały zapisany skład pozycji. Ilości składników wynikają z liczby wybranych
                          jednostek.
                        </p>
                        {line.components.map((component) => (
                          <label key={component.product_id}>
                            {component.name} · {component.sku} · {component.quantity} szt. na
                            jednostkę
                            <select
                              aria-label={'Produkt dostawcy dla ' + component.sku}
                              value={
                                draft[line.customer_item_id].mappings[component.product_id] ?? ''
                              }
                              disabled={locked || !canWrite}
                              onChange={(e) =>
                                edit({
                                  ...draft,
                                  [line.customer_item_id]: {
                                    ...draft[line.customer_item_id],
                                    mappings: {
                                      ...draft[line.customer_item_id].mappings,
                                      [component.product_id]: e.target.value,
                                    },
                                  },
                                })
                              }
                            >
                              <option value="">Wybierz jawne powiązanie</option>
                              {component.mappings.map((mapping) => (
                                <option
                                  key={mapping.catalog_item_id}
                                  value={mapping.catalog_item_id}
                                >
                                  {mapping.name} · {mapping.sku} · wersja {mapping.version}
                                </option>
                              ))}
                            </select>
                            {!component.mappings.length && (
                              <small>
                                Brak powiązanego produktu w ofercie tego dostawcy. Nie można zlecić
                                tej pozycji.
                              </small>
                            )}
                          </label>
                        ))}
                      </div>
                    ))}
                  <button
                    className="button primary"
                    disabled={locked || !canWrite || !Object.keys(draft).length}
                    onClick={createQuote}
                  >
                    Sprawdź warunki dostawy do klienta
                  </button>
                </section>
              )}
              {quote && (
                <section className="drop-section">
                  <h3>Wycena · {quote.customer_number}</h3>
                  <p>
                    Ważna do {date(quote.expires_at)}. Poniższy odbiorca i pozycje pochodzą z
                    zapisanej wyceny.
                  </p>
                  <ReceiverView receiver={quote.receiver} />
                  <FrozenItems items={quote.items} financial={financial} />
                  <WholesaleView wholesale={quote.wholesale} financial={financial} />
                  <RetailView
                    retail={quote.retail}
                    currency={quote.retail.currency}
                    financial={financial}
                    balanceBasis="quote"
                  />
                  {quote.blockers.length > 0 && (
                    <div className="drop-notice drop-error">
                      {quote.blockers.map((b, i) => (
                        <p key={i}>{b}</p>
                      ))}
                    </div>
                  )}
                  {quote.current_order_id && (
                    <button
                      className="button"
                      disabled={locked}
                      onClick={() =>
                        void read<Flags & { order: DropOrder }>(
                          prefix + '/orders/' + quote.current_order_id,
                          (d) => {
                            setOrder(d.order);
                            setTab('orders');
                            resetConsents();
                          },
                        )
                      }
                    >
                      Odczytaj wcześniej zapisane zlecenie
                    </button>
                  )}
                  <label className="drop-check">
                    <input
                      type="checkbox"
                      checked={receiverConsent}
                      disabled={locked || !canWrite || !quote.can_checkout}
                      onChange={(e) => setReceiverConsent(e.target.checked)}
                    />
                    Potwierdzam dostawę na pokazany adres końcowego klienta.
                  </label>
                  <label className="drop-check">
                    <input
                      type="checkbox"
                      checked={consent}
                      disabled={locked || !canWrite || !quote.can_checkout}
                      onChange={(e) => setConsent(e.target.checked)}
                    />
                    Potwierdzam zakup tych pozycji od dostawcy na pokazanych warunkach. Zobowiązanie
                    wobec dostawcy jest osobne od płatności klienta.
                  </label>
                  <button
                    className="button primary"
                    disabled={
                      locked ||
                      !canWrite ||
                      !quote.ready ||
                      !quote.can_checkout ||
                      !consent ||
                      !receiverConsent
                    }
                    onClick={checkout}
                  >
                    Zleć dostawę do klienta
                  </button>
                </section>
              )}
            </>
          )}
          {tab === 'quotes' && (
            <section className="drop-section">
              <div className="drop-actions">
                <h3>Historia wycen</h3>
                <button className="button" disabled={busy} onClick={() => void history('quotes')}>
                  Odśwież wyceny
                </button>
              </div>
              {quotes ? (
                <>
                  <div className="drop-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>Zamówienie klienta</th>
                          <th>Utworzono</th>
                          <th>Stan</th>
                          {financial && <th>Zakup u dostawcy brutto</th>}
                          <th>Szczegóły</th>
                        </tr>
                      </thead>
                      <tbody>
                        {quotes.data.map((q) => (
                          <tr key={q.id}>
                            <td>{q.customer_number}</td>
                            <td>{date(q.created_at)}</td>
                            <td>
                              {q.current_order_id
                                ? 'Zamówienie zapisane'
                                : q.ready
                                  ? 'Wycena gotowa'
                                  : 'Wycena z wyjątkami'}
                            </td>
                            {financial && (
                              <td>{money(q.wholesale.total_minor, q.wholesale.currency)}</td>
                            )}
                            <td>
                              <button
                                className="button"
                                disabled={locked}
                                onClick={() =>
                                  void read<Flags & { quote: Quote }>(
                                    prefix + '/quotes/' + q.id,
                                    (d) => {
                                      setQuote(d.quote);
                                      setSource(null);
                                      setDraft({});
                                      setTab('new');
                                      resetConsents();
                                    },
                                  )
                                }
                              >
                                Odczytaj wycenę
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <Pagination
                    count={quotes.data.length}
                    total={quotes.meta.total}
                    cursor={quotes.meta.cursor}
                    disabled={busy}
                    onFirst={() => void history('quotes')}
                    onNext={() => void history('quotes', quotes.meta.cursor!)}
                  />
                  {!quotes.data.length && <p>Brak zapisanych wycen dla tego połączenia.</p>}
                </>
              ) : (
                <p>Odczytaj historię wycen tego dostawcy.</p>
              )}
            </section>
          )}
          {tab === 'orders' && (
            <>
              <section className="drop-section">
                <div className="drop-actions">
                  <h3>Zlecenia dostawcy</h3>
                  <button className="button" disabled={busy} onClick={() => void history('orders')}>
                    Odśwież zlecenia
                  </button>
                </div>
                {orders ? (
                  <>
                    <div className="drop-scroll">
                      <table>
                        <thead>
                          <tr>
                            <th>Zamówienie klienta</th>
                            <th>Zamówienie dostawcy</th>
                            <th>Utworzono</th>
                            <th>Stan</th>
                            {financial && <th>Zobowiązanie brutto</th>}
                            <th>Szczegóły</th>
                          </tr>
                        </thead>
                        <tbody>
                          {orders.data.map((o) => (
                            <tr key={o.id}>
                              <td>{o.customer_number}</td>
                              <td>{o.supplier_number}</td>
                              <td>{date(o.created_at)}</td>
                              <td>{o.state === 'cancelled' ? 'Anulowano' : 'Zamówiono'}</td>
                              {financial && (
                                <td>{money(o.wholesale.total_minor, o.wholesale.currency)}</td>
                              )}
                              <td>
                                <button
                                  className="button"
                                  disabled={locked}
                                  onClick={() =>
                                    void read<Flags & { order: DropOrder }>(
                                      prefix + '/orders/' + o.id,
                                      (d) => {
                                        setOrder(d.order);
                                        resetConsents();
                                        setCancelReason('');
                                      },
                                    )
                                  }
                                >
                                  Odczytaj zlecenie
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <Pagination
                      count={orders.data.length}
                      total={orders.meta.total}
                      cursor={orders.meta.cursor}
                      disabled={busy}
                      onFirst={() => void history('orders')}
                      onNext={() => void history('orders', orders.meta.cursor!)}
                    />
                    {!orders.data.length && <p>Brak zapisanych zleceń dla tego połączenia.</p>}
                  </>
                ) : (
                  <p>Odczytaj zlecenia tego dostawcy.</p>
                )}
              </section>
              {order && (
                <section className="drop-section">
                  <div className="drop-actions">
                    <h3>
                      {order.supplier_number} → klient {order.customer_number}
                    </h3>
                    <button
                      className="button"
                      disabled={locked}
                      onClick={() =>
                        void read<Flags & { order: DropOrder }>(
                          prefix + '/orders/' + order.id,
                          (d) => {
                            setOrder(d.order);
                            resetConsents();
                          },
                        )
                      }
                    >
                      Odczytaj realizację ponownie
                    </button>
                  </div>
                  <p>
                    Wersja {order.version} ·{' '}
                    {order.state === 'cancelled'
                      ? 'Anulowano'
                      : (statusNames[order.fulfillment.status] ?? order.fulfillment.status)}{' '}
                    ·{' '}
                    {order.reconciled
                      ? 'Realizacja uzgodniona'
                      : 'Realizacja jeszcze nieuzgodniona'}
                  </p>
                  <ReceiverView receiver={order.receiver} />
                  <FrozenItems items={order.items} financial={financial} />
                  <WholesaleView wholesale={order.wholesale} financial={financial} />
                  <RetailView
                    retail={order.retail}
                    currency={order.retail.currency}
                    financial={financial}
                    balanceBasis="current"
                  />
                  {financial && order.fulfillment.payment_balance && (
                    <BalanceView
                      title="Saldo zobowiązania wobec dostawcy"
                      balance={order.fulfillment.payment_balance}
                    />
                  )}
                  <h4>Przesyłki dostawcy</h4>
                  {order.fulfillment.shipments.length ? (
                    order.fulfillment.shipments.map((shipment, index) => (
                      <p key={index}>
                        {shipment.carrier} · {shipment.tracking_number} ·{' '}
                        {['demo', 'simulation'].includes(shipment.mode) ? 'DEMO' : shipment.status}
                        {shipment.dispatched_at
                          ? ' · wydano ' + date(shipment.dispatched_at)
                          : ' · bez potwierdzonego wydania'}
                      </p>
                    ))
                  ) : (
                    <p>Brak zapisanych przesyłek.</p>
                  )}
                  <B2bDropshipCustomerTracking path={prefix} order={order} canWrite={canWrite && order.state === 'ordered'} onOrder={setOrder} />
                  {order.fulfillment.historical && (
                    <p className="drop-notice">
                      Zamówienie u dostawcy jest historycznym źródłem po połączeniu. Odczyt pokazuje
                      własny pierwotny zakup; nie pokazuje danych innych klientów.
                    </p>
                  )}
                  {!order.fulfillment.read_only &&
                    order.state === 'ordered' &&
                    !order.reconciled && (
                      <div className="drop-subsection">
                        <h4>Uzgodnij rzeczywistą realizację</h4>
                        <p>
                          Wymagane jest potwierdzone wydanie u dostawcy oraz pełne rozliczenie
                          pozostałych fizycznych pozycji zamówienia klienta. Ta akcja nie tworzy
                          fikcyjnych skanów, wpłat ani PZ.
                        </p>
                        <label className="drop-check">
                          <input
                            type="checkbox"
                            checked={reconcileConsent}
                            disabled={locked || !canWrite || !order.can_reconcile}
                            onChange={(e) => setReconcileConsent(e.target.checked)}
                          />
                          Potwierdzam odczyt i uzgodnienie rzeczywistej realizacji dla tego
                          zlecenia.
                        </label>
                        <button
                          className="button"
                          disabled={
                            locked || !canWrite || !order.can_reconcile || !reconcileConsent
                          }
                          onClick={reconcile}
                        >
                          Uzgodnij realizację
                        </button>
                      </div>
                    )}
                  {order.can_cancel && (
                    <div className="drop-subsection">
                      <h4>Anulowanie zlecenia</h4>
                      <p>
                        {order.fulfillment_basis === 'external_intent'
                          ? 'Możliwe wyłącznie przed wydaniem przez dostawcę. Ilość wróci do niezleconej intencji zewnętrznej, bez tworzenia lokalnej rezerwacji ani zapasu.'
                          : 'Możliwe wyłącznie przed wydaniem przez dostawcę. Przywrócenie lokalnej rezerwacji może zostać zablokowane, jeśli w Twoim magazynie zabraknie dostępnego towaru; dokładna próba zostanie zachowana do ręcznego ponowienia.'}
                      </p>
                      <label>
                        Uzasadnienie anulowania
                        <input
                          value={cancelReason}
                          maxLength={1000}
                          disabled={locked || !canWrite}
                          onChange={(e) => {
                            setCancelReason(e.target.value);
                            setCancelConsent(false);
                          }}
                        />
                      </label>
                      <label className="drop-check">
                        <input
                          type="checkbox"
                          checked={cancelConsent}
                          disabled={locked || !canWrite}
                          onChange={(e) => setCancelConsent(e.target.checked)}
                        />
                        Potwierdzam anulowanie zlecenia u dostawcy i sprawdzenie możliwości
                        zwolnienia jego rezerwacji.
                      </label>
                      <button
                        className="button"
                        disabled={
                          locked || !canWrite || !cancelConsent || cancelReason.trim().length < 3
                        }
                        onClick={cancel}
                      >
                        Anuluj zlecenie
                      </button>
                    </div>
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

function ReceiverView({ receiver }: { receiver: Receiver }) {
  return (
    <div className="drop-receiver">
      <h4>Odbiorca paczki — końcowy klient</h4>
      <strong>{receiver.customer_name}</strong>
      <p>{addressText(receiver.address)}</p>
      <p>{receiver.email}</p>
    </div>
  );
}
function BalanceView({ title, balance }: { title: string; balance: Balance }) {
  return (
    <div className="drop-balance">
      <h4>{title}</h4>
      <div className="drop-amounts">
        <span>
          Otrzymano <strong>{money(balance.received, balance.currency)}</strong>
        </span>
        <span>
          Wypłacono zwroty <strong>{money(balance.refunded, balance.currency)}</strong>
        </span>
        <span>
          Do zapłaty <strong>{money(balance.amount_due, balance.currency)}</strong>
        </span>
        <span>
          Nadpłata <strong>{money(balance.overpayment, balance.currency)}</strong>
        </span>
      </div>
    </div>
  );
}
function RetailView({
  retail,
  currency,
  financial,
  balanceBasis = 'current',
}: {
  retail: Retail;
  currency: string;
  financial: boolean;
  balanceBasis?: 'current' | 'quote';
}) {
  return (
    <div className="drop-subsection">
      <h4>Płatność klienta w Twoim zamówieniu</h4>
      <p>
        {retail.payment_mode === 'cod' ? 'Pobranie klienta' : 'Przedpłata klienta'}. To rozliczenie
        jest oddzielne od przedpłaty Twojej firmy u dostawcy.
      </p>
      {financial && (
        <>
          <p>
            Wartość zamówienia klienta:{' '}
            {currency ? money(retail.total_minor, currency) : 'Brak danych o walucie'} · dostawa:{' '}
            {currency ? money(retail.shipping_minor, currency) : 'Brak danych o walucie'}
          </p>
          {retail.payment_balance && (
            <BalanceView
              title={
                balanceBasis === 'quote'
                  ? 'Saldo klienta w chwili wyceny'
                  : 'Saldo klienta z ostatniego odczytu'
              }
              balance={retail.payment_balance}
            />
          )}
        </>
      )}
    </div>
  );
}
function WholesaleView({ wholesale, financial }: { wholesale: Wholesale; financial: boolean }) {
  return (
    <div className="drop-wholesale">
      <h4>Zakup Twojej firmy u dostawcy</h4>
      <p>
        Przedpłata u dostawcy · {wholesale.currency}. Faktura dla: {wholesale.bill_to.name} · NIP{' '}
        {wholesale.bill_to.tax_id || 'nie podano'}.
      </p>
      <p>{addressText(wholesale.bill_to.address)}</p>
      <div className="drop-scroll">
        <table>
          <thead>
            <tr>
              <th>Produkt dostawcy</th>
              <th>Ilość fizyczna</th>
              {financial && (
                <>
                  <th>VAT</th>
                  <th>Cena jednostkowa brutto</th>
                  <th>Wartość brutto</th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {wholesale.items.map((item, index) => (
              <tr key={item.source_product_id + ':' + index}>
                <td>
                  {item.name}
                  <small>{item.sku}</small>
                </td>
                <td>{item.quantity}</td>
                {financial && (
                  <>
                    <td>{item.vat}%</td>
                    <td>{money(item.unit_gross_minor, wholesale.currency)}</td>
                    <td>{money(item.line_total_minor, wholesale.currency)}</td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {financial && (
        <div className="drop-amounts">
          <span>
            Dostawa brutto <strong>{money(wholesale.shipping_minor, wholesale.currency)}</strong>
          </span>
          <span>
            Zobowiązanie brutto <strong>{money(wholesale.total_minor, wholesale.currency)}</strong>
          </span>
        </div>
      )}
      <p>Towar jedzie do klienta. Ten zakup nie jest przyjęciem do Twojego magazynu.</p>
    </div>
  );
}
function Pagination({
  count,
  total,
  cursor,
  disabled,
  onFirst,
  onNext,
}: {
  count: number;
  total?: number;
  cursor: string | null;
  disabled: boolean;
  onFirst: () => void;
  onNext: () => void;
}) {
  return (
    <div className="drop-pagination">
      <span>
        Na stronie: {count}
        {typeof total === 'number' && Number.isFinite(total) && ` · w zakresie: ${total}`}
      </span>
      <button className="button" disabled={disabled} onClick={onFirst}>
        Pierwsza strona
      </button>
      {cursor && (
        <button className="button" disabled={disabled} onClick={onNext}>
          Następna strona
        </button>
      )}
    </div>
  );
}

function FrozenItems({ items, financial }: { items: Item[]; financial: boolean }) {
  return (
    <div className="drop-subsection">
      <h4>Wybrane pozycje zamówienia klienta</h4>
      <p>
        Ilość zlecona dotyczy całych jednostek zapisanej pozycji. Ceny i wartość odnoszą się do
        oryginalnej pozycji klienta, a zakup od dostawcy jest wyceniony osobno.
      </p>
      <div className="drop-scroll">
        <table>
          <thead>
            <tr>
              <th>Pozycja klienta</th>
              <th>Oryginalna ilość</th>
              <th>Zlecono jednostek</th>
              {financial && (
                <>
                  <th>Cena klienta brutto</th>
                  <th>Pełna oryginalna wartość brutto</th>
                </>
              )}
              <th>Powiązania składników</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.customer_item_id}>
                <td>
                  {item.name ?? 'Pozycja klienta'}
                  <small>{item.sku}</small>
                  <details>
                    <summary>Identyfikator pozycji</summary>
                    <code>{item.customer_item_id}</code>
                  </details>
                </td>
                <td>{item.original_quantity ?? 'Brak danych'}</td>
                <td>{item.quantity}</td>
                {financial && (
                  <>
                    <td>
                      {item.currency ? money(item.unit_price_minor, item.currency) : 'Brak danych'}
                      <small>VAT {item.vat ?? '—'}%</small>
                    </td>
                    <td>
                      {item.currency ? money(item.line_total_minor, item.currency) : 'Brak danych'}
                    </td>
                  </>
                )}
                <td>
                  {item.mappings.map((mapping) => (
                    <p key={mapping.product_id}>
                      {mapping.product_name ?? 'Składnik'} · {mapping.product_sku ?? '—'}
                      {' → '}
                      {mapping.source_name ?? 'Produkt dostawcy'} · {mapping.source_sku ?? '—'}
                      {mapping.quantity !== undefined && (
                        <small>{mapping.quantity} szt. na jednostkę pozycji</small>
                      )}
                    </p>
                  ))}
                  <details>
                    <summary>Zapisane powiązania</summary>
                    {item.mappings.map((mapping) => (
                      <p key={mapping.product_id}>
                        <code>{mapping.product_id}</code> → <code>{mapping.catalog_item_id}</code>
                      </p>
                    ))}
                  </details>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export type B2bDropshippingOrderProjection = {
  items: {
    customer_item_id: string;
    original_quantity: number;
    external_committed_quantity: number;
    external_dispatched_quantity: number;
    local_required_quantity: number;
  }[];
  orders: {
    id: string;
    link_id: string;
    supplier_number: string;
    state: string;
    supplier_status: string;
    dispatched: boolean;
    shipments: {
      carrier: string;
      tracking_number: string;
      status: string;
      mode: string;
      dispatched_at: string | null;
    }[];
  }[];
  external_quantity: number;
  external_dispatched_quantity: number;
  local_required_quantity: number;
  reconciled: boolean;
};

/** Read-only projection supplied by getOrder; original quantities and scans stay intact. */
export function B2bDropshippingOrderScope({
  scope,
  items,
}: {
  scope?: B2bDropshippingOrderProjection | null;
  items: { id: string; sku: string; name: string }[];
}) {
  if (!scope || (!scope.orders.length && !scope.external_quantity)) return null;
  return (
    <section className="network-dropshipping" aria-label="Realizacja przez Twoją firmę i dostawców">
      <h3>Realizacja lokalna i dostawa od dostawcy</h3>
      <p>
        Oryginalne ilości zamówienia i rzeczywiste skany pozostają zachowane. Poniżej jednostki
        pozycji handlowych są rozdzielone między Twoją firmę i dostawców; zestawy nadal mają własne
        składniki fizyczne.
      </p>
      <div className="drop-amounts">
        <span>
          Lokalna część zamówienia <strong>{scope.local_required_quantity} jednostek</strong>
        </span>
        <span>
          Przekazano dostawcom <strong>{scope.external_quantity} jednostek</strong>
        </span>
        <span>
          Wydano u dostawców <strong>{scope.external_dispatched_quantity} jednostek</strong>
        </span>
      </div>
      <div className="drop-scroll">
        <table>
          <thead>
            <tr>
              <th>Pozycja klienta</th>
              <th>Oryginalna ilość</th>
              <th>Do realizacji lokalnie</th>
              <th>Przekazano dostawcom</th>
              <th>Wydano u dostawców</th>
            </tr>
          </thead>
          <tbody>
            {scope.items.map((row) => {
              const item = items.find((i) => i.id === row.customer_item_id);
              return (
                <tr key={row.customer_item_id}>
                  <td>
                    {item?.name ?? 'Pozycja klienta'}
                    <small>{item?.sku}</small>
                  </td>
                  <td>{row.original_quantity}</td>
                  <td>{row.local_required_quantity}</td>
                  <td>{row.external_committed_quantity}</td>
                  <td>{row.external_dispatched_quantity}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <h4>Zlecenia dostawców</h4>
      {scope.orders.map((order) => (
        <div key={order.id} className="drop-subsection">
          <strong>{order.supplier_number}</strong>
          <p>
            {order.state === 'cancelled'
              ? 'Zlecenie anulowane'
              : (statusNames[order.supplier_status] ?? order.supplier_status)}{' '}
            · {order.dispatched ? 'Wydanie potwierdzone' : 'Bez potwierdzonego wydania'}
          </p>
          {order.shipments.map((shipment, index) => (
            <p key={index}>
              {shipment.carrier} · {shipment.tracking_number} ·{' '}
              {['demo', 'simulation'].includes(shipment.mode) ? 'DEMO' : shipment.status}
              {shipment.dispatched_at ? ' · wydano ' + date(shipment.dispatched_at) : ''}
            </p>
          ))}
        </div>
      ))}
      <p className="drop-notice">
        {scope.reconciled
          ? 'Cała realizacja została uzgodniona na podstawie zapisanych wydań.'
          : 'Po rzeczywistym wydaniu części lokalnej i wszystkich części dostawców uzgodnij realizację w sekcji „Dostawa do klienta” sieci B2B.'}{' '}
        Zakup od dostawcy nie tworzy PZ w Twoim magazynie.
      </p>
    </section>
  );
}
