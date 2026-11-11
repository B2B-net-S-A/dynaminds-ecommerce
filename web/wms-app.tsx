/** Packer module at /wms: a separate, minimal screen for people who only pack and ship orders.
 * It reuses the existing order endpoints (list, detail, status, scan, notes, demo shipping) and the
 * session of the main app; it has no sales navigation on purpose (client feedback 11.2026). */
import React, { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiError, money } from './api';
import { orderScanBody } from './order-scan';
import { ITEM_MISSING_STATUSES, MissingItemButton, itemMissingPath } from './order-item-missing';
import { isRuleBarcode, ruleBarcodeBody, ruleBarcodeText } from './automation-barcode';
import { packingPath, parseAppPath, ROUTE_EVENT, writeHistory } from './app-route';
import './wms-app.css';

type Row = Record<string, any>;
type Tab = 'todo' | 'packed' | 'shipped';
type Failure = { message: string; retry?: () => void };
export type WmsUser = { id: string; tenant_id: string; name: string; role: string };

/** "Do spakowania": ready to fulfil (code `paid`, labelled "Nowe") and already started (`picking`).
 * Code `new` means "Nieopłacone" and never reaches the packer. */
export const WMS_TODO_STATUSES = ['paid', 'picking'] as const;
const NOT_STARTED = new Set(['paid']);

/** /wms (alias) and /pakowanie[/<order number>] open the packer module (Uwagi v3 §8). */
export const isWmsPath = (path: string) =>
  path === '/wms' || path.startsWith('/wms/') || path === '/pakowanie' || path.startsWith('/pakowanie/');

/** Order number in /pakowanie/<number>, else null. */
export function wmsOrderRef(path: string): string | null {
  const route = parseAppPath(path);
  return route.kind === 'packing' ? route.ref : null;
}

/** Address-bar state for the module, so /pakowanie survives a reload and the browser back button works. */
export function useWmsRoute() {
  const read = () => ({ active: isWmsPath(window.location.pathname), ref: wmsOrderRef(window.location.pathname) });
  const [state, setState] = useState(read);
  useEffect(() => {
    const onPop = () => setState((prev) => {
      const next = read();
      return next.active === prev.active && next.ref === prev.ref ? prev : next;
    });
    window.addEventListener('popstate', onPop);
    window.addEventListener(ROUTE_EVENT, onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
      window.removeEventListener(ROUTE_EVENT, onPop);
    };
  }, []);
  const open = useCallback((number?: string | null) => {
    const target = packingPath(number);
    if (number ? window.location.pathname !== target : !isWmsPath(window.location.pathname)) writeHistory(target);
    setState({ active: true, ref: number ?? null });
  }, []);
  /** Opening or leaving an order inside the module: one history entry per step. */
  const setOrder = useCallback((number: string | null) => {
    if (!isWmsPath(window.location.pathname)) return;
    writeHistory(packingPath(number));
    setState({ active: true, ref: number });
  }, []);
  const close = useCallback(() => {
    if (isWmsPath(window.location.pathname)) writeHistory('/');
    setState({ active: false, ref: null });
  }, []);
  /** Entry refused (an office operation is still pending): back to the office without a new history entry. */
  const refuse = useCallback(() => {
    if (isWmsPath(window.location.pathname)) writeHistory('/', true);
    setState({ active: false, ref: null });
  }, []);
  return { active: state.active, ref: state.ref, open, setOrder, close, refuse };
}

const GENERIC_ERROR = 'Nie udało się połączyć z serwerem. Spróbuj ponownie.';
/** Server messages are Polish already; transport failures (TypeError, broken JSON) get a plain sentence. */
export function wmsErrorMessage(e: unknown) {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error && e.constructor === Error && e.message) return e.message;
  return GENERIC_ERROR;
}

const sameDay = (iso: string, now: Date) => {
  const d = new Date(iso);
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
};
const byOldest = (a: Row, b: Row) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? ''));

/** Short product line for a list row: a server summary (string, array of items, or first item name with
 * line and quantity totals), else items carried by the row. Never fetched per row. */
export function itemSummary(row: Row): string | null {
  const s = row.items_summary ?? row.product_summary;
  if (typeof s === 'string' && s.trim()) return s.trim();
  if (typeof row.first_item_name === 'string' && row.first_item_name.trim()) {
    const name = row.first_item_name.trim();
    const lines = Number(row.line_count);
    const qty = Number(row.quantity_total);
    if (lines > 1) return `${name} + ${lines - 1} inne`;
    return qty > 1 ? `${qty}× ${name}` : name;
  }
  const list = Array.isArray(s) ? s : Array.isArray(row.items) ? row.items : null;
  if (!list) return null;
  const names = list
    .map((i: Row) => ((Number(i.quantity) > 1 ? `${i.quantity}× ` : '') + (i.name ?? i.sku ?? '')).trim())
    .filter(Boolean);
  if (!names.length) return null;
  return names.length > 3 ? `${names.slice(0, 2).join(', ')} + ${names.length - 2} inne` : names.join(', ');
}
/** Pieces in the order: `quantity_total` or `item_count` (both sums of quantities), else the row's items. */
function itemCount(row: Row): number | null {
  if (typeof row.quantity_total === 'number') return row.quantity_total;
  if (typeof row.item_count === 'number') return row.item_count;
  return Array.isArray(row.items) ? row.items.reduce((n: number, i: Row) => n + (Number(i.quantity) || 0), 0) : null;
}

const DELIVERY: Record<string, string> = {
  parcel_locker: 'Paczkomat', pickup_point: 'Punkt odbioru', courier: 'Kurier', post: 'Poczta',
  personal_pickup: 'Odbiór osobisty', digital: 'Wysyłka cyfrowa', other: 'Inna dostawa',
};
/** Delivery line for a row or an order; the list has no carrier yet, so the city is the fallback. */
export function deliveryText(o: Row): string {
  const method = o.delivery_label ?? o.delivery_method_label ?? DELIVERY[o.delivery_method] ?? o.shipments?.[0]?.carrier;
  const city = o.address?.city ? `Dostawa: ${o.address.city}` : 'Dostawa na adres klienta';
  const cod = o.payment_mode === 'cod' && typeof o.total === 'number' ? ` · pobranie ${money(o.total, o.currency)}` : '';
  return (method || city) + cod;
}
const excerpt = (s: unknown, n = 120) => {
  const t = typeof s === 'string' ? s.trim() : '';
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

/** With several locations the server needs one; the packer only scans the product, so pick the next open bin. */
export function scanLocationFor(order: Row, code: string): string {
  const line = (order.picking_items ?? []).find(
    (i: Row) => (i.sku === code || i.ean === code) && i.scanned < i.quantity,
  );
  const bins: Row[] = line?.locations ?? [];
  if (bins.length <= 1) return '';
  return bins.find((b) => b.state === 'active' && b.scanned < b.quantity)?.location ?? '';
}
function progress(order: Row) {
  const lines: Row[] = order.picking_items ?? [];
  const required = lines.reduce((n, i) => n + i.quantity, 0);
  const scanned = lines.reduce((n, i) => n + Math.min(i.scanned, i.quantity), 0);
  return { required, scanned, complete: required > 0 && scanned === required };
}

/** The list API returns newest first, so to show the oldest orders first every page is read, up to this cap. */
export const WMS_LIST_CAP = 1000;
async function loadAll(status: string): Promise<{ rows: Row[]; more: boolean }> {
  const rows: Row[] = [];
  let after: string | null = null;
  do {
    const page: Row = await api(`/orders?status=${status}&limit=200${after ? `&after=${encodeURIComponent(after)}` : ''}`);
    rows.push(...(page.data ?? []));
    after = page.meta?.has_more && typeof page.meta.cursor === 'string' ? page.meta.cursor : null;
  } while (after && rows.length < WMS_LIST_CAP);
  return { rows: rows.sort(byOldest), more: after !== null };
}

type Lists = { todo: Row[]; packed: Row[]; shipped: Row[]; more: Record<Tab, boolean>; shippedToday: boolean };
async function loadLists(): Promise<Lists> {
  const [todo, packed, shipped] = await Promise.all([
    loadAll(WMS_TODO_STATUSES.join(',')),
    loadAll('packed'),
    api('/orders?status=shipped&limit=100'),
  ]);
  const shippedRows: Row[] = shipped.data ?? [];
  // updated_at is the last status change for a shipped order; without it show the latest shipments.
  const shippedToday = shippedRows.length === 0 || shippedRows.every((r) => typeof r.updated_at === 'string');
  const now = new Date();
  return {
    todo: todo.rows,
    packed: packed.rows,
    shipped: shippedToday ? shippedRows.filter((r) => sameDay(r.updated_at, now)) : shippedRows,
    more: { todo: todo.more, packed: packed.more, shipped: !shippedToday && !!shipped.meta?.has_more },
    shippedToday,
  };
}

function ScanField(props: {
  label: string; placeholder: string; value: string; onChange: (v: string) => void;
  onSubmit: (e: FormEvent) => void; inputRef?: React.Ref<HTMLInputElement>; disabled?: boolean; button: string;
}) {
  return (
    <form className="wms-scan" role="search" onSubmit={props.onSubmit}>
      <label className="wms-scan-box">
        <svg aria-hidden="true" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M3 7V4h3M18 4h3v3M21 17v3h-3M6 20H3v-3M7 8v8M10 8v8M13 8v8M17 8v8" />
        </svg>
        <span className="wms-sr">{props.label}</span>
        <input
          ref={props.inputRef}
          value={props.value}
          onChange={(e) => props.onChange(e.target.value)}
          placeholder={props.placeholder}
          disabled={props.disabled}
          autoFocus
          autoComplete="off"
          maxLength={200}
        />
      </label>
      <button className="wms-big" type="submit" disabled={props.disabled}>{props.button}</button>
    </form>
  );
}

function Alert({ failure }: { failure: Failure | null }) {
  if (!failure) return null;
  return (
    <div className="wms-alert" role="alert">
      <span>{failure.message}</span>
      {failure.retry && <button className="wms-big" type="button" onClick={failure.retry}>Spróbuj ponownie</button>}
    </div>
  );
}

export function WmsApp(props: {
  user: WmsUser; readOnly: boolean; onOffice?: () => void; onLogout: () => Promise<void> | void;
  /** Order number from /pakowanie/<number>; null = the list. */
  routeOrder?: string | null;
  /** Called when the packer opens an order (its number) or returns to the list (null). */
  onRouteOrder?: (number: string | null) => void;
}) {
  const [tab, setTab] = useState<Tab>('todo');
  const [lists, setLists] = useState<Lists | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [info, setInfo] = useState('');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<{ query: string; rows: Row[] } | null>(null);
  const [current, setCurrent] = useState<{ id: string; number?: string; startVersion?: string } | null>(null);
  const scanRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    setFailure(null);
    try {
      setLists(await loadLists());
    } catch (e) {
      setFailure({ message: wmsErrorMessage(e), retry: () => void refresh() });
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const rows = results ? results.rows : lists?.[tab] ?? [];
  const show = (row: Row) => setCurrent({
    id: row.id,
    number: row.number == null ? undefined : String(row.number),
    ...(!props.readOnly && NOT_STARTED.has(row.status) ? { startVersion: String(row.version) } : {}),
  });
  const openRow = (row: Row) => {
    setInfo('');
    show(row);
    if (row.number != null) props.onRouteOrder?.(String(row.number));
  };
  const back = (message = '') => {
    setCurrent(null);
    setInfo(message);
    if (props.routeOrder) props.onRouteOrder?.(null);
    void refresh();
  };
  // The address decides which order is open: a reload, a link or the back button. Opening from the address
  // starts picking like the "Pakuj" button (only while the order still waits; a reload finds it in picking).
  const routeOrder = props.routeOrder ?? null;
  useEffect(() => {
    if (!routeOrder) { setCurrent((c) => (c ? null : c)); return; }
    if (current?.number === routeOrder) return;
    let live = true;
    setFailure(null);
    api<Row>(`/orders/by-number/${encodeURIComponent(routeOrder)}`)
      .then((row) => { if (live) show(row); })
      .catch((e) => { if (live) { setCurrent(null); setFailure({ message: wmsErrorMessage(e) }); } });
    return () => { live = false; };
  }, [routeOrder]);

  const find = async (e: FormEvent) => {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;
    setFailure(null);
    setInfo('');
    const up = q.toUpperCase();
    const all = lists ? [...lists.todo, ...lists.packed, ...lists.shipped] : [];
    const local = all.filter((r) => String(r.number).toUpperCase() === up);
    if (local.length === 1) { setQuery(''); openRow(local[0]); return; }
    try {
      const found: Row[] = (await api(`/orders?search=${encodeURIComponent(q)}&limit=10`)).data ?? [];
      const exact = found.filter((r) => String(r.number).toUpperCase() === up);
      const hit = exact.length === 1 ? exact[0] : found.length === 1 ? found[0] : null;
      if (hit) { setQuery(''); setResults(null); openRow(hit); }
      else if (!found.length) setFailure({ message: `Nie znaleziono zamówienia „${q}”.` });
      else setResults({ query: q, rows: found });
    } catch (err) {
      setFailure({ message: wmsErrorMessage(err), retry: () => void find(e) });
    } finally {
      scanRef.current?.focus();
    }
  };

  const logout = async () => {
    try { await props.onLogout(); } catch (e) { setFailure({ message: wmsErrorMessage(e) }); }
  };
  const header = (
    <header className="wms-header">
      {current ? (
        <button type="button" className="wms-back" onClick={() => back()}>‹ Wróć do listy</button>
      ) : (
        <div className="wms-brand">D. <span>MAGAZYN</span></div>
      )}
      <div className="wms-user">
        <span>{props.user.name}</span>
        {props.onOffice && <button type="button" className="wms-link" onClick={props.onOffice}>Panel biura</button>}
        <button type="button" className="wms-link" onClick={() => void logout()}>Wyloguj</button>
      </div>
    </header>
  );

  if (current)
    return (
      <div className="wms-app">
        {header}
        <Packing key={current.id} id={current.id} startVersion={current.startVersion} readOnly={props.readOnly}
          onShipped={(number) => back(`Zamówienie ${number} nadane.`)} />
      </div>
    );

  const count = (t: Tab) => (lists ? `${lists[t].length}${lists.more[t] ? '+' : ''}` : '…');
  const tabs: { id: Tab; label: string }[] = [
    { id: 'todo', label: 'Do spakowania' },
    { id: 'packed', label: 'Spakowane' },
    { id: 'shipped', label: lists && !lists.shippedToday ? 'Ostatnio wysłane' : 'Wysłane dziś' },
  ];
  const empty = results ? 'Brak wyników.' : tab === 'todo' ? 'Nie ma zamówień do spakowania.'
    : tab === 'packed' ? 'Nie ma spakowanych zamówień.' : 'Dziś nic jeszcze nie wysłano.';
  return (
    <div className="wms-app">
      {header}
      <main className="wms-main">
        <ScanField label="Skanuj zamówienie" placeholder="Zeskanuj lub wpisz numer zamówienia" value={query}
          onChange={setQuery} onSubmit={(e) => void find(e)} inputRef={scanRef} button="Otwórz" />
        {props.readOnly && <p className="wms-note-info">Tryb tylko do odczytu — pakowanie jest wyłączone.</p>}
        {info && <p className="wms-success" role="status">{info}</p>}
        <Alert failure={failure} />
        {!results && tab !== 'shipped' && lists?.more[tab] && (
          <p className="wms-note-info">
            Pokazano {lists[tab].length} najnowszych z ponad {WMS_LIST_CAP} zamówień — starszych nie ma na tej liście.
            Wpisz numer zamówienia w polu powyżej, aby je otworzyć.
          </p>
        )}
        <div className="wms-tabs-row">
          <div className="wms-tabs" role="tablist" aria-label="Zakładki magazynu">
            {tabs.map((t) => (
              <button key={t.id} type="button" role="tab" aria-selected={!results && tab === t.id}
                className={`wms-tab ${!results && tab === t.id ? 'active' : ''}`}
                onClick={() => { setResults(null); setTab(t.id); }}>
                {t.label} <span className="wms-cnt">{count(t.id)}</span>
              </button>
            ))}
            <button type="button" role="tab" aria-selected={false} className="wms-tab" disabled>
              Zwroty <span className="wms-cnt">wkrótce</span>
            </button>
          </div>
          <button type="button" className="wms-tab wms-refresh" onClick={() => void refresh()}>Odśwież</button>
        </div>
        {results && (
          <div className="wms-results">
            <span>Wyniki dla „{results.query}”</span>
            <button type="button" className="wms-link dark" onClick={() => setResults(null)}>Wyczyść</button>
          </div>
        )}
        {lists === null && !failure ? (
          <p className="wms-empty">Wczytywanie…</p>
        ) : rows.length === 0 ? (
          <p className="wms-empty">{empty}</p>
        ) : (
          <ul className="wms-list">
            {rows.map((r) => {
              const n = itemCount(r);
              const summary = itemSummary(r);
              const note = excerpt(r.note);
              const action = props.readOnly || ['shipped', 'delivered', 'completed'].includes(r.status) ? 'Podgląd'
                : r.status === 'packed' ? 'Nadaj' : 'Pakuj';
              return (
                <li key={r.id} className="wms-row">
                  <div className="wms-row-id">
                    <strong>{r.number}</strong>
                    <span>{r.customer_name}</span>
                  </div>
                  <div className="wms-row-items">
                    {n !== null && <strong>{n} szt.</strong>}{n !== null && summary ? ' · ' : ''}{summary}
                  </div>
                  <div className="wms-row-ship">{deliveryText(r)}</div>
                  {note && <div className="wms-row-note">{note}</div>}
                  <button type="button" className={`wms-big ${action === 'Podgląd' ? '' : 'primary'}`}
                    aria-label={`${action} ${r.number}`} onClick={() => openRow(r)}>{action}</button>
                </li>
              );
            })}
          </ul>
        )}
      </main>
    </div>
  );
}

function Packing(props: { id: string; startVersion?: string; readOnly: boolean; onShipped: (number: string) => void }) {
  const { id } = props;
  const [order, setOrder] = useState<Row | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState('');
  const [last, setLast] = useState<{ sku: string; text: string } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [info, setInfo] = useState('');
  const scanRef = useRef<HTMLInputElement>(null);
  const shipRef = useRef<HTMLButtonElement>(null);
  const headRef = useRef<HTMLHeadingElement>(null);
  // Updated as soon as a response arrives, so the next queued scan sees it before React re-renders.
  const orderRef = useRef<Row | null>(null);
  const queue = useRef<Promise<void>>(Promise.resolve());
  // Scans waiting in the queue; a failure bumps `epoch`, which drops them (the packer is told which).
  const scans = useRef<{ epoch: number; waiting: string[] }>({ epoch: 0, waiting: [] });

  const accept = (r: Row) => {
    if (r?.id === id && Array.isArray(r.picking_items)) { orderRef.current = r; setOrder(r); return r; }
    return null;
  };
  const reload = async () => {
    try { return accept(await api(`/orders/${id}`)); } catch { return null; }
  };

  /** Opening a `new` order starts picking, so nobody in the office has to hand it over first. */
  const open = useCallback(async (startVersion?: string) => {
    setBusy(true);
    setFailure(null);
    try {
      if (startVersion !== undefined) {
        try {
          if (accept(await api(`/orders/${id}/status`, 'PATCH', { status: 'picking', expected_version: startVersion }))) return;
        } catch (e) {
          const fresh = accept(await api(`/orders/${id}`));
          if (fresh?.status !== 'picking')
            setFailure({
              message: wmsErrorMessage(e),
              retry: fresh && NOT_STARTED.has(fresh.status) ? () => void open(String(fresh.version)) : undefined,
            });
          return;
        }
      }
      if (!accept(await api(`/orders/${id}`))) throw new Error('Nie udało się wczytać zamówienia.');
    } catch (e) {
      setFailure({ message: wmsErrorMessage(e), retry: () => void open(startVersion) });
    } finally {
      setBusy(false);
    }
  }, [id]);
  useEffect(() => { void open(props.startVersion); }, [open]);

  /** One write at a time. A 409 means the order changed elsewhere: show the fresh version and allow a retry.
   * Without an answer (network, broken reply, 5xx) the write may have been applied, so the order is reloaded
   * and `unsure` decides from the real state; nothing is resent blindly. Resolves true on success. */
  const write = async (
    run: () => Promise<Row>,
    opts: { retry: () => void; done?: (r: Row) => void; unsure: (e: unknown, fresh: Row | null) => Failure | null },
  ) => {
    setBusy(true);
    setFailure(null);
    setInfo('');
    try {
      const r = (await run()) as Row;
      const fresh = accept(r) ?? (await reload());
      if (fresh) opts.done?.(fresh);
      return true;
    } catch (e) {
      if (!(e instanceof ApiError) || e.status >= 500) setFailure(opts.unsure(e, await reload()));
      else {
        if (e.status === 409) await reload();
        // A refused code or missing data will not change on resend.
        setFailure({ message: wmsErrorMessage(e), retry: e.status === 409 ? opts.retry : undefined });
      }
      return false;
    } finally {
      setBusy(false);
    }
  };
  /** The reload after an unanswered write failed too: offer to read the order again, never to resend. */
  const reloadFailure = (message: string): Failure => ({
    message: `${message} Nie udało się też odświeżyć zamówienia.`,
    retry: () => void reload().then((r) => { if (r) setFailure({ message }); }),
  });

  const scanned = (r: Row, value: string) => {
    const line = (r.picking_items as Row[]).find((i) => i.sku === value || i.ean === value);
    setLast(line ? { sku: line.sku, text: `Zeskanowano: ${line.name} (${line.scanned}/${line.quantity})` } : null);
  };
  /** The body is built when the job runs, from the order after the previous scan, so the bin is the next open one. */
  const sendScan = async (value: string) => {
    const o = orderRef.current;
    if (!o) return;
    if (isRuleBarcode(value)) {
      // A printed rule code (AR-…) runs that automation rule for this order instead of counting a product.
      let run: Row | null = null;
      await write(
        async () => {
          run = (await api('/automations/v2/barcode', 'POST', ruleBarcodeBody(value, id))) as Row;
          return run;
        },
        {
          retry: () => enqueueScan(value),
          done: () => {
            setLast(null);
            if (run) setInfo(ruleBarcodeText(run));
          },
          unsure: (_e, fresh) => {
            const message = `Nie wiemy, czy akcja z kodu „${value}” została uruchomiona — sprawdź historię zamówienia.`;
            return fresh ? { message } : reloadFailure(message);
          },
        },
      );
      return;
    }
    const body = orderScanBody({ code: value, location: scanLocationFor(o, value), lotsEnabled: o.wms_lots_enabled === true,
      newKey: () => crypto.randomUUID() });
    const ok = await write(() => api(`/orders/${id}/scan`, 'POST', body), {
      retry: () => enqueueScan(value),
      done: (r) => scanned(r, value),
      unsure: (_e, fresh) => {
        const message = `Nie wiemy, czy skan „${value}” dotarł — sprawdź licznik i zeskanuj ponownie, jeśli trzeba.`;
        return fresh ? { message } : reloadFailure(message);
      },
    });
    if (ok) return;
    // Later scans were aimed at the state before this failure; drop them and say which, so none counts unseen.
    const dropped = scans.current.waiting;
    scans.current = { epoch: scans.current.epoch + 1, waiting: [] };
    setFailure((f) => {
      if (!f) return f;
      const named = f.message.includes(`„${value}”`) ? f.message : `Skan „${value}”: ${f.message}`;
      return { ...f, message: dropped.length
        ? `${named} Nie wysłano kolejnych skanów (${dropped.length}): ${dropped.join(', ')} — zeskanuj je ponownie.` : named };
    });
  };
  const enqueueScan = (value: string) => {
    const epoch = scans.current.epoch;
    scans.current.waiting.push(value);
    const job = async () => {
      if (epoch !== scans.current.epoch) return;
      scans.current.waiting.shift();
      await sendScan(value);
    };
    queue.current = queue.current.then(job, job);
  };
  const scan = (e: FormEvent) => {
    e.preventDefault();
    const value = code.trim();
    setCode('');
    if (value && orderRef.current) enqueueScan(value);
  };

  const packed = () => {
    const done = () => { setLast(null); setInfo('Spakowane. Teraz nadaj przesyłkę.'); };
    const run = () => write(
      () => api(`/orders/${id}/status`, 'PATCH', { status: 'packed', expected_version: String(orderRef.current?.version) }),
      {
        retry: () => void run(),
        done,
        // The expected version guards a resend, but only offer it while the order is still being picked.
        unsure: (e, fresh) => {
          if (fresh?.status === 'packed') { done(); return null; }
          return fresh ? { message: wmsErrorMessage(e), retry: fresh.status === 'picking' ? () => void run() : undefined }
            : reloadFailure(wmsErrorMessage(e));
        },
      },
    );
    void run();
  };
  const ship = () => {
    const run = () => write(() => api(`/orders/${id}/ship-demo`, 'POST'), {
      retry: () => void run(),
      done: (r) => props.onShipped(r.number),
      unsure: (e, fresh) => {
        if (fresh?.status === 'shipped') { props.onShipped(fresh.number); return null; }
        return fresh ? { message: wmsErrorMessage(e), retry: fresh.status === 'packed' ? () => void run() : undefined }
          : reloadFailure(wmsErrorMessage(e));
      },
    });
    void run();
  };
  const report = (e: FormEvent) => {
    e.preventDefault();
    const text = (problem ?? '').trim();
    if (!text) return;
    const note = `[WMS] ${text}`;
    const copies = (o: Row | null) => String(o?.note ?? '').split('\n').filter((l) => l === note).length;
    const done = () => { setProblem(null); setInfo('Zgłoszenie zapisane w notatce zamówienia.'); };
    const run = () => {
      const before = copies(orderRef.current);
      return write(() => api(`/orders/${id}/operations`, 'POST', { type: 'add_note', note }), {
        retry: () => void run(),
        done,
        // The note is appended as its own line: one more copy than before means it was saved.
        unsure: (_e, fresh) => {
          if (!fresh) return reloadFailure('Nie wiemy, czy zgłoszenie dotarło.');
          if (copies(fresh) > before) { done(); return null; }
          return { message: 'Zgłoszenie nie trafiło do notatki zamówienia. Spróbuj ponownie.', retry: () => void run() };
        },
      });
    };
    void run();
  };

  /** "Zgłoś brak" at a line (automation event order.item_missing). The retry key makes a resend safe. */
  const reportMissing = async (item: Row, body: { quantity_missing: number; client_key: string }): Promise<boolean> => {
    setBusy(true);
    setFailure(null);
    try {
      await api(itemMissingPath(id, item.id), 'POST', body);
      setInfo(`Zgłoszono brak: ${item.sku} · ${body.quantity_missing} szt.`);
      return true;
    } catch (e) {
      setFailure({ message: wmsErrorMessage(e), retry: () => void reportMissing(item, body) });
      return false;
    } finally {
      setBusy(false);
    }
  };

  // After a write: the scan field while picking, then "Nadaj przesyłkę", else the order heading.
  useEffect(() => {
    if (busy || problem !== null) return;
    if (scanRef.current) scanRef.current.focus();
    else if (shipRef.current && !shipRef.current.disabled) shipRef.current.focus();
    else headRef.current?.focus();
  }, [busy, problem, order?.status]);

  if (!order)
    return (
      <main className="wms-main">
        {failure ? <Alert failure={failure} /> : <p className="wms-empty">Wczytywanie zamówienia…</p>}
      </main>
    );

  const p = progress(order);
  const canWrite = !props.readOnly;
  const picking = order.status === 'picking';
  const lines: Row[] = order.picking_items;
  // Pick lines carry the SKU; a set's components have no order line of their own and get no "Zgłoś brak".
  const orderLine = (sku: string): Row | undefined => (order.items ?? []).find((it: Row) => it.sku === sku);
  const canReportMissing = canWrite && ITEM_MISSING_STATUSES.includes(order.status);
  const actions = canWrite && (
    <div className="wms-actions">
      {problem === null ? (
        ['picking', 'packed'].includes(order.status) && (
          <button type="button" className="wms-big" disabled={busy} onClick={() => setProblem('')}>Zgłoś problem</button>
        )
      ) : (
        <form className="wms-problem" onSubmit={report}>
          <label htmlFor="wms-problem-text">Opisz problem (trafi do notatki zamówienia)</label>
          <input id="wms-problem-text" value={problem} onChange={(e) => setProblem(e.target.value)}
            maxLength={480} autoFocus required placeholder="np. brak towaru w lokalizacji" />
          <button type="submit" className="wms-big primary" disabled={busy || !problem.trim()}>Wyślij zgłoszenie</button>
          <button type="button" className="wms-big" onClick={() => setProblem(null)}>Anuluj</button>
        </form>
      )}
      <div className="wms-actions-main">
        {picking && (
          <>
            {!p.complete && <span id="wms-packed-hint" className="wms-hint">Zeskanuj wszystkie produkty, aby spakować.</span>}
            <button type="button" className="wms-big success" disabled={busy || !p.complete}
              aria-describedby={p.complete ? undefined : 'wms-packed-hint'} onClick={packed}>Spakowane</button>
          </>
        )}
        {order.status === 'packed' && (
          <>
            {order.shipping_active && <span className="wms-hint">Przesyłka jest przygotowywana w panelu biura.</span>}
            <button ref={shipRef} type="button" className="wms-big success" disabled={busy || !!order.shipping_active}
              onClick={ship}>
              Nadaj przesyłkę
            </button>
          </>
        )}
      </div>
    </div>
  );
  return (
    <main className="wms-main">
      {picking && canWrite && (
        <ScanField label="Skanuj produkt" placeholder="Zeskanuj produkt (EAN lub SKU)" value={code} onChange={setCode}
          onSubmit={scan} inputRef={scanRef} button="Skanuj" />
      )}
      <div className="wms-order-head">
        <div>
          <h1 ref={headRef} tabIndex={-1}>{order.number}</h1>
          <p>{order.customer_name} · {deliveryText(order)}</p>
        </div>
        <div className="wms-progress-text" aria-live="polite">{p.scanned} / {p.required} zeskanowane</div>
      </div>
      <div className="wms-bar" role="progressbar" aria-label="Postęp skanowania" aria-valuemin={0}
        aria-valuemax={p.required} aria-valuenow={p.scanned}>
        <div style={{ width: `${p.required ? (p.scanned / p.required) * 100 : 0}%` }} />
      </div>
      {excerpt(order.note, 2000) && <div className="wms-note"><strong>Notatka:</strong> {order.note}</div>}
      {last && <p className="wms-success" role="status">{last.text}</p>}
      {info && <p className="wms-success" role="status">{info}</p>}
      <Alert failure={failure} />
      {!picking && !info && (
        <p className="wms-note-info">
          {NOT_STARTED.has(order.status) ? 'Kompletacja tego zamówienia jeszcze się nie rozpoczęła.'
            : order.status === 'packed' ? 'Zamówienie jest spakowane.'
              : `Status zamówienia: ${order.status === 'shipped' ? 'nadane' : order.status}.`}
        </p>
      )}
      {!picking && actions}
      <ul className="wms-list">
        {lines.map((i) => {
          const done = i.scanned >= i.quantity;
          return (
            <li key={i.id} className={`wms-line ${done ? 'done' : ''} ${last?.sku === i.sku ? 'last' : ''}`}>
              <div className="wms-photo" aria-hidden="true">{String(i.name ?? i.sku).slice(0, 1)}</div>
              <div className="wms-line-name">
                <strong>{i.name}</strong>
                <span>{i.ean ? `EAN ${i.ean} · ` : ''}SKU {i.sku}</span>
              </div>
              <div className="wms-line-loc">{(i.locations ?? []).map((b: Row) => b.location).join(', ') || '—'}</div>
              <div className="wms-line-qty" aria-label={`Zeskanowano ${i.scanned} z ${i.quantity}`}>
                {done ? '✓ ' : ''}{i.scanned}/{i.quantity}
              </div>
              {canReportMissing && orderLine(i.sku) && (
                <div className="wms-line-missing">
                  <MissingItemButton quantity={orderLine(i.sku)!.quantity} scanned={i.scanned} busy={busy}
                    onReport={(body) => reportMissing(orderLine(i.sku)!, body)} />
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {picking && actions}
    </main>
  );
}
