import { useEffect, useRef, useState } from 'react';
import { api, date } from './api';
import {
  AccessAndRetry,
  SnapshotView,
  checkSnapshot,
  notifySavedOnce,
  useProformaIO,
  type ProformaAttempt,
  type ProformaSharedProps,
  type ProformaSnapshot,
} from './proformas';
import './proforma-batches.css';

type Flags = {
  available: boolean;
  read_only: boolean;
  can_read: boolean;
  can_write: boolean;
  current_role: string;
};
type Totals = { currency: string; gross_minor: string; net_minor: string; vat_minor: string };
type BatchRow = {
  index: number;
  order_id: string;
  order_version: string;
  preview_id: string;
  scope_hash: string;
  snapshot: ProformaSnapshot;
  document?: { id: string; order_id: string; number: string; kind: 'proforma'; mode: 'local' };
  receipt?: {
    id: string;
    document_id: string;
    preview_id: string;
    series_id: string;
    number: string;
    scope_hash: string;
  };
};
type Head = {
  id: string;
  series_id: string;
  shipping_vat: number;
  scope_hash: string;
  summary: { orders: number; currencies: Totals[] };
  rows: BatchRow[];
  created_at: string;
  expires_at?: string;
  can_issue?: boolean;
  issued_execution_id?: string | null;
  preview_id?: string;
};
type Reply = Flags & { preview?: Head; execution?: Head; reused?: boolean };
type HistoryHead = Omit<Head, 'rows'> & { kind: 'preview' | 'execution' };
type History = Flags & {
  kind: 'preview' | 'execution';
  data: HistoryHead[];
  next_cursor: string | null;
};
type View = { kind: 'preview' | 'execution'; reply: Reply };
const uuid = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const version = (v: unknown): v is string =>
  typeof v === 'string' && /^[1-9][0-9]{0,18}$/.test(v) && BigInt(v) <= 9223372036854775807n;
function amount(v: unknown): bigint {
  if (typeof v !== 'string' || !/^(0|[1-9][0-9]*)$/.test(v))
    throw Error('Nieprawidłowa kwota w zapisanej partii proform.');
  return BigInt(v);
}
function money(v: string, currency: string) {
  const n = amount(v);
  return `${(n / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ')},${(n % 100n).toString().padStart(2, '0')} ${currency}`;
}
function flags(r: Flags) {
  if (
    !r ||
    ['available', 'read_only', 'can_read', 'can_write'].some(
      (key) => typeof r[key as keyof Flags] !== 'boolean',
    ) ||
    typeof r.current_role !== 'string' ||
    !r.available ||
    !r.can_read
  )
    throw Error('Niepełny odczyt dostępu do zbiorczych proform.');
}
function validateReply(r: Reply, kind: 'preview' | 'execution') {
  flags(r);
  const h = kind === 'preview' ? r.preview : r.execution;
  if (
    !h ||
    !uuid(h.id) ||
    !uuid(h.series_id) ||
    !hash(h.scope_hash) ||
    !Number.isInteger(h.shipping_vat) ||
    h.shipping_vat < 0 ||
    h.shipping_vat > 100 ||
    !Array.isArray(h.rows) ||
    h.rows.length < 1 ||
    h.rows.length > 50 ||
    h.summary?.orders !== h.rows.length ||
    !Array.isArray(h.summary.currencies)
  )
    throw Error('Niepełny zapisany zakres zbiorczych proform. Zachowano dokładną próbę.');
  if (
    kind === 'preview' &&
    (typeof h.can_issue !== 'boolean' ||
      !h.expires_at ||
      !Number.isFinite(Date.parse(h.expires_at)) ||
      (h.issued_execution_id !== null && !uuid(h.issued_execution_id)))
  )
    throw Error('Niepełny status podglądu zbiorczych proform.');
  if (kind === 'execution' && !uuid(h.preview_id))
    throw Error('Brak powiązania wykonania z podglądem.');
  const orderIds = new Set<string>(),
    childIds = new Set<string>(),
    documents = new Set<string>(),
    receipts = new Set<string>();
  const totals = new Map<string, { gross: bigint; net: bigint; vat: bigint }>();
  let previous = '';
  h.rows.forEach((row, index) => {
    if (
      row.index !== index ||
      !uuid(row.order_id) ||
      !version(row.order_version) ||
      !uuid(row.preview_id) ||
      !hash(row.scope_hash) ||
      orderIds.has(row.order_id) ||
      childIds.has(row.preview_id) ||
      (previous && row.order_id <= previous)
    )
      throw Error('Pozycje partii proform nie mają pełnej jednoznacznej kolejności.');
    orderIds.add(row.order_id);
    childIds.add(row.preview_id);
    previous = row.order_id;
    checkSnapshot(row.snapshot, row.order_id);
    if (
      row.snapshot.order.version !== row.order_version ||
      row.snapshot.series.id !== h.series_id ||
      row.snapshot.lines.find((l) => l.kind === 'shipping')?.vat_rate !== h.shipping_vat
    )
      throw Error('Dane pojedynczej proformy nie odpowiadają całej partii.');
    const t = totals.get(row.snapshot.currency) ?? { gross: 0n, net: 0n, vat: 0n };
    t.gross += amount(row.snapshot.totals.gross_minor);
    t.net += amount(row.snapshot.totals.net_minor);
    t.vat += amount(row.snapshot.totals.vat_minor);
    totals.set(row.snapshot.currency, t);
    if (kind === 'execution') {
      const d = row.document,
        receipt = row.receipt;
      if (
        !d ||
        !uuid(d.id) ||
        d.order_id !== row.order_id ||
        d.kind !== 'proforma' ||
        d.mode !== 'local' ||
        !d.number ||
        documents.has(d.id) ||
        !receipt ||
        !uuid(receipt.id) ||
        receipts.has(receipt.id) ||
        receipt.document_id !== d.id ||
        receipt.preview_id !== row.preview_id ||
        receipt.series_id !== h.series_id ||
        receipt.scope_hash !== row.scope_hash ||
        receipt.number !== d.number
      )
        throw Error('Niepełne potwierdzone dokumenty lub powiązania partii.');
      documents.add(d.id);
      receipts.add(receipt.id);
    }
  });
  const currencies = new Set<string>();
  for (const c of h.summary.currencies) {
    const t = totals.get(c.currency);
    if (
      !t ||
      currencies.has(c.currency) ||
      amount(c.gross_minor) !== t.gross ||
      amount(c.net_minor) !== t.net ||
      amount(c.vat_minor) !== t.vat
    )
      throw Error('Podsumowanie walut nie odpowiada pełnej partii proform.');
    currencies.add(c.currency);
  }
  if (currencies.size !== totals.size) throw Error('Brak waluty w podsumowaniu partii proform.');
  return h;
}
function validateWrite(r: Reply, a: ProformaAttempt) {
  if (!['batch-preview', 'batch-issue'].includes(a.kind))
    throw Error('Nieprawidłowy rodzaj próby zbiorczej.');
  const h = validateReply(r, a.kind === 'batch-preview' ? 'preview' : 'execution');
  const request = JSON.parse(a.body);
  if (a.kind === 'batch-preview') {
    if (
      h.series_id !== request.series_id ||
      h.shipping_vat !== request.shipping_vat ||
      JSON.stringify(
        h.rows.map((row) => ({ order_id: row.order_id, order_version: row.order_version })),
      ) !== JSON.stringify(request.orders)
    )
      throw Error('Podgląd zbiorczy nie odpowiada dokładnie zachowanemu żądaniu.');
  } else if (
    h.scope_hash !== request.scope_hash ||
    a.path !== `/proformas/batches/previews/${h.preview_id}/issue`
  )
    throw Error('Wykonanie zbiorcze nie odpowiada zachowanemu podglądowi.');
}

export function ProformaBatchPanel(
  props: ProformaSharedProps & {
    selectedIds: string[];
    onChanged: () => void;
    onOpenOrder?: (id: string) => void;
  },
) {
  const io = useProformaIO<Reply>(props, 'batch', validateWrite);
  const canonicalIds = [...props.selectedIds].map((id) => id.toLowerCase()).sort();
  const selectionKey = JSON.stringify(canonicalIds);
  const scopeKey = `${props.contextKey}:readonly=${props.readOnly}`;
  const [seriesId, setSeriesId] = useState(''),
    [shippingVat, setShippingVat] = useState('');
  const [view, setView] = useState<View | null>(null),
    [consent, setConsent] = useState(false);
  const [history, setHistory] = useState<HistoryHead[]>([]),
    [cursor, setCursor] = useState<string | null>(null);
  const [historyKind, setHistoryKind] = useState<'preview' | 'execution'>('execution');
  const [error, setError] = useState(''),
    [now, setNow] = useState(Date.now());
  const [dataScope, setDataScope] = useState(scopeKey),
    [preparing, setPreparing] = useState(false);
  const [seen, setSeen] = useState<Record<string, boolean>>({});
  const [opened, setOpened] = useState<Record<string, boolean>>({});
  const seenReply = useRef<Reply | null>(null);
  const selectedScope = useRef('');
  selectedScope.current = `${scopeKey}:${selectionKey}:${seriesId}:${shippingVat}`;
  const mounted = useRef(false),
    generation = useRef(0);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current++;
    };
  }, []);
  useEffect(() => {
    generation.current++;
    setSeriesId('');
    setShippingVat('');
    setView(null);
    setConsent(false);
    setHistory([]);
    setCursor(null);
    setError('');
    setSeen({});
    setOpened({});
    setDataScope(scopeKey);
    setPreparing(false);
    seenReply.current = null;
  }, [scopeKey]);
  useEffect(() => {
    if (!io.options?.can_read) {
      generation.current++;
      setView(null);
      setHistory([]);
      setCursor(null);
      setSeen({});
      setOpened({});
      setConsent(false);
      setPreparing(false);
    }
  }, [io.options?.can_read]);
  useEffect(() => {
    generation.current++;
    setConsent(false);
    setSeen({});
    setOpened({});
    setPreparing(false);
    setView((old) => (old?.kind === 'preview' ? null : old));
  }, [selectionKey]);
  useEffect(() => {
    if (!io.reply || seenReply.current === io.reply.value) return;
    seenReply.current = io.reply.value;
    if (!['batch-preview', 'batch-issue'].includes(io.reply.kind)) return;
    const kind = io.reply.kind === 'batch-preview' ? 'preview' : 'execution';
    validateReply(io.reply.value, kind);
    setView({ kind, reply: io.reply.value });
    setConsent(false);
    setSeen({});
    setOpened({});
    setError('');
    if (kind === 'execution') notifySavedOnce(io.reply.value, props.onChanged);
  }, [io.reply, props.onChanged]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const vat = /^\d{1,3}$/.test(shippingVat) ? Number(shippingVat) : -1;
  const validSelection =
    canonicalIds.length >= 1 &&
    canonicalIds.length <= 50 &&
    canonicalIds.every(uuid) &&
    new Set(canonicalIds).size === canonicalIds.length;
  const head = view?.kind === 'preview' ? view.reply.preview : view?.reply.execution;
  const headScope = `${scopeKey}:${head?.id ?? ''}`;
  const headScopeRef = useRef(headScope);
  headScopeRef.current = headScope;
  const expired =
    view?.kind === 'preview' && (!head?.expires_at || Date.parse(head.expires_at) <= now);
  const rejectedPreview =
    view?.kind === 'preview' &&
    !!head &&
    io.knownRejectedAttempts.some(
      (a) =>
        a.status === 409 &&
        a.kind === 'batch-issue' &&
        a.path === `/proformas/batches/previews/${head.id}/issue`,
    );
  useEffect(() => {
    if (rejectedPreview) setConsent(false);
  }, [rejectedPreview]);
  const allReviewed = !!head && head.rows.every((r) => seen[r.order_id]);
  function invalidate() {
    setConsent(false);
    setView(null);
    setSeen({});
    setOpened({});
    generation.current++;
  }
  function fail(e: unknown) {
    const m = e instanceof Error ? e.message : 'Nie udało się odczytać partii proform.';
    setError(m);
    props.onError?.(m);
  }
  async function prepare() {
    if (io.freshBlocked || preparing || !validSelection || !uuid(seriesId) || vat < 0 || vat > 100)
      return;
    const captured = selectedScope.current,
      n = ++generation.current;
    setPreparing(true);
    setConsent(false);
    setError('');
    try {
      const orders = await io.readData(async () =>
        Promise.all(
          canonicalIds.map(async (id) => {
            const o = await api<{ id: string; version: string | number }>('/orders/' + id);
            const v = String(o.version);
            if (
              o.id !== id ||
              !version(v) ||
              (typeof o.version === 'number' && !Number.isSafeInteger(o.version))
            )
              throw Error('Niepełna bieżąca wersja wybranego zamówienia.');
            return { order_id: id, order_version: v };
          }),
        ),
      );
      if (
        !orders ||
        !mounted.current ||
        n !== generation.current ||
        captured !== selectedScope.current
      )
        return;
      setView(null);
      setSeen({});
      setOpened({});
      io.submit('batch-preview', '/proformas/batches/previews', {
        series_id: seriesId,
        shipping_vat: vat,
        orders,
      });
    } catch (e) {
      if (mounted.current && n === generation.current && captured === selectedScope.current)
        fail(e);
    } finally {
      if (mounted.current && n === generation.current) setPreparing(false);
    }
  }
  async function open(kind: 'preview' | 'execution', id: string) {
    if (!uuid(id) || io.busy || preparing) return;
    const n = ++generation.current,
      scope = scopeKey;
    setConsent(false);
    setError('');
    const result = await io.readData(
      () =>
        api<Reply>(`/proformas/batches/${kind === 'preview' ? 'previews' : 'executions'}/${id}`),
      (r) => {
        const h = validateReply(r, kind);
        if (h.id !== id) throw Error('Odczytano inną partię proform.');
      },
    );
    if (result && mounted.current && n === generation.current && dataScope === scope) {
      setView({ kind, reply: result });
      setSeen({});
      setOpened({});
    }
  }
  async function loadHistory(kind: 'preview' | 'execution', next?: string) {
    if (io.busy || preparing) return;
    const n = ++generation.current;
    const result = await io.readData(
      () =>
        api<History>(
          '/proformas/batches/history?' +
            new URLSearchParams({ kind, ...(next ? { cursor: next } : {}) }),
        ),
      (r) => {
        flags(r);
        if (
          r.kind !== kind ||
          !Array.isArray(r.data) ||
          r.data.length > 50 ||
          (r.next_cursor !== null && (!uuid(r.next_cursor) || r.next_cursor === next)) ||
          r.data.some(
            (h) =>
              !uuid(h.id) ||
              h.kind !== kind ||
              !Number.isInteger(h.summary?.orders) ||
              h.summary.orders < 1 ||
              h.summary.orders > 50,
          )
        )
          throw Error('Niepełna strona historii zbiorczych proform.');
      },
    );
    if (result && mounted.current && n === generation.current) {
      const heads = result.data.map((h) => ({ ...h, kind: result.kind }));
      setHistory((old) =>
        next ? [...old, ...heads.filter((h) => !old.some((v) => v.id === h.id))] : heads,
      );
      setCursor(result.next_cursor);
      setHistoryKind(kind);
    }
  }
  function issue() {
    if (
      !head ||
      view?.kind !== 'preview' ||
      io.freshBlocked ||
      preparing ||
      !consent ||
      !allReviewed ||
      !head.can_issue ||
      head.issued_execution_id ||
      rejectedPreview ||
      expired
    )
      return;
    io.submit('batch-issue', `/proformas/batches/previews/${head.id}/issue`, {
      scope_hash: head.scope_hash,
      confirmed: true,
      local_only: true,
    });
  }
  if (dataScope !== scopeKey)
    return (
      <section className="panel proforma-batch-panel">
        <p>Odświeżanie kontekstu partii proform…</p>
      </section>
    );
  return (
    <section
      className="panel proforma-panel proforma-batch-panel"
      aria-label="Proformy dla wybranych zamówień"
    >
      <div className="panel-heading">
        <h2>Proformy dla wybranych zamówień</h2>
        <p>
          Jeden podgląd i osobna zgoda dla całej partii. Konflikt jednego zamówienia cofa całe
          wystawienie.
        </p>
      </div>
      <div className="info-body">
        <AccessAndRetry io={io} />
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {io.options && io.options.batch_available !== true && (
          <p>
            Zbiorcze proformy nie są dostępne w tej kopii. Odczyt ani wybór zamówień nie uruchamia
            wystawienia.
          </p>
        )}
        <fieldset disabled={io.freshBlocked || preparing}>
          <legend>Nowa partia · zaznaczono {canonicalIds.length} zamówień</legend>
          {!validSelection && (
            <p>
              Zaznacz od 1 do 50 różnych zamówień na liście. Żadne zamówienie nie zostanie
              automatycznie pominięte.
            </p>
          )}
          <div className="proforma-grid">
            <label>
              Seria proform
              <select
                value={seriesId}
                onChange={(e) => {
                  setSeriesId(e.target.value);
                  invalidate();
                }}
              >
                <option value="">Wybierz serię</option>
                {io.options?.series.map((s) => (
                  <option value={s.id} key={s.id}>
                    {s.name} · {s.prefix}
                  </option>
                ))}
              </select>
            </label>
            <label>
              VAT dostawy dla całej partii (%)
              <input
                type="number"
                min={0}
                max={100}
                step={1}
                value={shippingVat}
                onChange={(e) => {
                  setShippingVat(e.target.value);
                  invalidate();
                }}
              />
            </label>
          </div>
          <p>
            Seria i stawka VAT dostawy dotyczą każdego wybranego zamówienia. Pozycje zachowują
            historyczne ceny i VAT. Proformy nie zapisują wpłat ani wydania towaru.
          </p>
          <button
            className="button primary"
            disabled={!validSelection || !uuid(seriesId) || vat < 0 || vat > 100}
            onClick={() => void prepare()}
          >
            Przygotuj pełny podgląd partii
          </button>
        </fieldset>
        {head && view && io.options?.can_read && (
          <div className="proforma-review">
            <h3>
              {view.kind === 'preview'
                ? 'Pełny zapisany podgląd partii'
                : 'Potwierdzone wystawienie całej partii'}
            </h3>
            <p>
              {head.summary.orders} zamówień · {date(head.created_at)} · VAT dostawy{' '}
              {head.shipping_vat}%
            </p>
            <div className="table-scroll">
              <table>
                <caption>Sumy osobno dla każdej waluty — bez przeliczeń FX</caption>
                <thead>
                  <tr>
                    <th>Waluta</th>
                    <th>Netto</th>
                    <th>VAT</th>
                    <th>Brutto</th>
                  </tr>
                </thead>
                <tbody>
                  {head.summary.currencies.map((c) => (
                    <tr key={c.currency}>
                      <td>{c.currency}</td>
                      <td>{money(c.net_minor, c.currency)}</td>
                      <td>{money(c.vat_minor, c.currency)}</td>
                      <td>{money(c.gross_minor, c.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {head.rows.map((row) => (
              <article className="proforma-batch-row" key={`${head.id}:${row.order_id}`}>
                <h4>
                  {row.index + 1}. Zamówienie {row.snapshot.order.number}
                </h4>
                {props.onOpenOrder && (
                  <button
                    className="button"
                    disabled={io.locked || io.busy}
                    onClick={() => props.onOpenOrder?.(row.order_id)}
                  >
                    Otwórz zamówienie {row.snapshot.order.number}
                  </button>
                )}
                {row.document && (
                  <p>
                    <a
                      className="document-link"
                      href={`/api/documents/${row.document.id}/print`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Proforma {row.document.number} · Otwórz wydruk
                    </a>
                  </p>
                )}
                <details
                  onToggle={(e) => {
                    if (headScopeRef.current !== headScope) return;
                    const open = e.currentTarget.open;
                    setOpened((old) => ({ ...old, [row.order_id]: open }));
                    if (open) setSeen((old) => ({ ...old, [row.order_id]: true }));
                  }}
                >
                  <summary>
                    Dane stron, pozycje i sumy zamówienia {row.snapshot.order.number}
                  </summary>
                  {opened[row.order_id] && <SnapshotView snapshot={row.snapshot} />}
                </details>
              </article>
            ))}
            {view.kind === 'preview' && (
              <>
                <p>
                  {expired
                    ? 'Podgląd wygasł. Przygotuj nowy pełny podgląd.'
                    : `Podgląd ważny do ${date(head.expires_at!)}. Numery proform będą przydzielone dopiero po zatwierdzeniu.`}
                </p>
                {rejectedPreview && (
                  <p className="error" role="alert">
                    Wystawienie tego podglądu zostało odrzucone z powodu konfliktu. Przygotuj nowy
                    pełny podgląd bieżących danych przed ponowną zgodą.
                  </p>
                )}
                {head.issued_execution_id ? (
                  <button
                    className="button"
                    disabled={io.busy}
                    onClick={() => void open('execution', head.issued_execution_id!)}
                  >
                    Odczytaj zapisane wystawienie tej partii
                  </button>
                ) : (
                  <>
                    {!allReviewed && (
                      <p>
                        Otwórz szczegóły wszystkich {head.summary.orders} zamówień przed
                        potwierdzeniem.
                      </p>
                    )}
                    <label>
                      <input
                        type="checkbox"
                        checked={consent}
                        disabled={
                          io.freshBlocked ||
                          expired ||
                          rejectedPreview ||
                          !allReviewed ||
                          !head.can_issue
                        }
                        onChange={(e) => setConsent(e.target.checked)}
                      />{' '}
                      Potwierdzam wszystkie dane stron, pozycje, dostawę i sumy tej partii. Wystaw
                      lokalne proformy dla wszystkich zamówień jednocześnie.
                    </label>
                    <button
                      className="button primary"
                      disabled={
                        io.freshBlocked ||
                        expired ||
                        rejectedPreview ||
                        !allReviewed ||
                        !consent ||
                        !head.can_issue
                      }
                      onClick={issue}
                    >
                      Wystaw wszystkie proformy z podglądu
                    </button>
                  </>
                )}
              </>
            )}
          </div>
        )}
        <div className="proforma-batch-history">
          <h3>Historia partii proform</h3>
          <div className="toolbar-actions">
            <button
              className="button"
              disabled={io.busy || preparing || !io.options?.batch_available}
              onClick={() => void loadHistory('execution')}
            >
              Odczytaj historię wystawień
            </button>
            <button
              className="button"
              disabled={io.busy || preparing || !io.options?.batch_available}
              onClick={() => void loadHistory('preview')}
            >
              Odczytaj historię podglądów
            </button>
          </div>
          {history.map((h) => (
            <button
              className="button"
              key={`${h.kind}:${h.id}`}
              disabled={io.busy}
              onClick={() => void open(h.kind, h.id)}
            >
              {h.kind === 'execution' ? 'Wystawienie' : 'Podgląd'} · {h.summary.orders} zamówień ·{' '}
              {date(h.created_at)}
            </button>
          ))}
          {cursor && (
            <button
              className="button"
              disabled={io.busy}
              onClick={() => void loadHistory(historyKind, cursor)}
            >
              Starsze partie
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
