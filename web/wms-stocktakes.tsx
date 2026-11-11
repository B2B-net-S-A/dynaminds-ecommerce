import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api, ApiError, date } from './api';
import { StocktakeScans } from './stocktake-scans';
import { StocktakeAdjustmentsPanel, stocktakeAdjustmentsLocked, subscribeStocktakeAdjustmentsLock } from './stocktake-adjustments';
import './wms-stocktakes.css';

const prefix = '/wms-lots/stocktakes';
type Flags = {
  available: boolean;
  read_only: boolean;
  current_role: string;
  can_create: boolean;
  can_count: boolean;
  can_review: boolean;
  can_post: boolean;
  can_read_value: boolean;
  can_read?: boolean;
};
type Policy = { enabled: boolean; version: string; currency: string | null; exponent: number };
type Metadata = Flags & {
  policy: Policy;
  warehouses: { id: string; name: string; code?: string }[];
  limits: Record<string, number>;
};
type Head = {
  id: string;
  warehouse_id: string;
  name: string;
  state: 'counting' | 'review' | 'posted' | 'cancelled';
  version: string;
  scope_hash: string;
  line_count: number;
  counted_count: number;
  needs_recount_count: number;
  created_at: string;
  latest_review_id: string | null;
  posting_id: string | null;
  blind: boolean;
  currency: string;
};
type Line = {
  id: string;
  product_id: string;
  sku: string;
  name: string;
  location: string;
  lot: { id: string | null; lot_code: string; expiry_date: string | null };
  counted: number | null;
  version: string;
  basis_token: string;
  needs_recount: boolean;
  original_quantity?: number;
  current_quantity?: number;
  reserved?: number;
  difference?: number | null;
  scope_changed?: boolean;
};
type Page<T> = Flags & { data: T[]; meta: { cursor: string | null } };
type HeadResponse = Flags & { stocktake: Head; reused?: boolean };
type Attempt = { path: string; body: unknown; label: string; complete: (response: any) => void };
class StaleRead extends Error {}
const problem = (e: unknown) =>
  e instanceof Error ? e.message : 'Nie udało się wykonać operacji.';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const stateName: Record<Head['state'], string> = {
  counting: 'Liczenie',
  review: 'Przegląd',
  posted: 'Rozliczono',
  cancelled: 'Anulowano',
};

function integer(text: string, label: string, max = 2147483647n) {
  if (!/^(0|[1-9]\d*)$/.test(text))
    throw new Error(label + ': wpisz pełną liczbę całkowitą, również jawne zero.');
  const n = BigInt(text);
  if (n > max) throw new Error(label + ': wartość przekracza dozwolony zakres.');
  return Number(n);
}
function currencyText(minor: string | null | undefined, currency: string | null, exponent: number) {
  if (minor == null) return 'Koszt nieznany';
  if (
    !currency ||
    !Number.isInteger(exponent) ||
    exponent < 0 ||
    exponent > 6 ||
    !/^-?\d+$/.test(minor)
  )
    return 'Wartość niedostępna';
  const n = BigInt(minor),
    negative = n < 0n,
    v = negative ? -n : n;
  const divisor = 10n ** BigInt(exponent);
  return `${negative ? '−' : ''}${(v / divisor).toString()}${exponent ? ',' + (v % divisor).toString().padStart(exponent, '0') : ''} ${currency}`;
}
function costMinor(text: string, exponent: number) {
  if (!Number.isInteger(exponent) || exponent < 0 || exponent > 6)
    throw new Error('Brak dokładności waluty polityki.');
  const value = text.trim().replace(',', '.');
  if (!/^(0|[1-9]\d*)(?:\.\d+)?$/.test(value))
    throw new Error('Koszt: wpisz kwotę netto bez znaku i wykładnika. Puste pole nie jest zerem.');
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > exponent) throw new Error('Koszt ma zbyt wiele miejsc po przecinku.');
  const minor =
    BigInt(whole) * 10n ** BigInt(exponent) + BigInt(fraction.padEnd(exponent, '0') || '0');
  if (minor > 9223372036854775807n) throw new Error('Koszt przekracza zakres int64.');
  return minor.toString();
}
function boundedText(text: string, label: string, min: number, max: number) {
  const result = text.trim();
  if (
    result.length < min ||
    result.length > max ||
    result.includes('\0') ||
    new TextDecoder().decode(new TextEncoder().encode(result)) !== result
  ) {
    throw new Error(`${label}: wymagane ${min}–${max} znaków poprawnego tekstu, bez NUL.`);
  }
  return result;
}
function noteText(text: string) {
  return boundedText(text, 'Uzasadnienie', 3, 500);
}
function writeAllowed(data: Partial<Flags>, path: string) {
  if (!data.available || data.read_only) return false;
  if (path === prefix) return data.can_create === true;
  if (path.endsWith('/counts')) return data.can_count === true;
  if (path.endsWith('/reviews')) return data.can_review === true && data.can_read_value === true;
  if (path.endsWith('/post')) return data.can_post === true && data.can_read_value === true;
  return data.can_create === true;
}

function useStocktakeIO(
  contextKey: string,
  readOnly: boolean,
  purge: () => void,
  reject: (status: number) => void,
  externalWriteBlocked = false,
  freshWriteBlocked: () => boolean = () => false,
) {
  const externalBlocked = useRef(externalWriteBlocked);
  externalBlocked.current = externalWriteBlocked;
  const freshBlock = useRef(freshWriteBlocked);
  freshBlock.current = freshWriteBlocked;
  const live = useRef(false),
    epoch = useRef(0),
    gate = useRef(false),
    role = useRef<string | null>(null);
  const purgeRef = useRef(purge),
    rejectRef = useRef(reject),
    pendingRef = useRef<Attempt | null>(null);
  purgeRef.current = purge;
  rejectRef.current = reject;
  const [busy, setBusy] = useState(false),
    [blocked, setBlocked] = useState(false);
  const [error, setError] = useState(''),
    [pending, setPending] = useState<Attempt | null>(null);
  const current = (e: number) => live.current && epoch.current === e;
  function deny() {
    ++epoch.current;
    gate.current = false;
    pendingRef.current = null;
    setBusy(false);
    setPending(null);
    setBlocked(true);
    purgeRef.current();
    setError(
      'Dostęp został cofnięty lub zmieniła się rola. Odśwież uprawnienia przed ponownym otwarciem panelu.',
    );
  }
  function accept(data: Partial<Flags>) {
    if (role.current && data.current_role && role.current !== data.current_role) {
      deny();
      throw new StaleRead();
    }
    if (data.current_role) role.current = data.current_role;
    if (data.available && data.can_read === false) {
      deny();
      throw new StaleRead();
    }
    if (
      data.read_only ||
      data.available === false ||
      (pendingRef.current && !writeAllowed(data, pendingRef.current.path))
    ) {
      setBlocked(true);
      pendingRef.current = null;
      setPending(null);
      if (!data.read_only && data.available !== false)
        setError(
          'Uprawnienie do tej operacji zostało cofnięte. Odczytaj wynik; ponowny zapis w tym panelu jest zablokowany.',
        );
    }
  }
  async function get<T>(path: string): Promise<T> {
    const e = epoch.current;
    try {
      const data = await api<T>(path);
      if (!current(e)) throw new StaleRead();
      accept(data as Partial<Flags>);
      if (!current(e)) throw new StaleRead();
      return data;
    } catch (err) {
      if (current(e) && err instanceof ApiError && [401, 403].includes(err.status)) deny();
      throw err;
    }
  }
  async function read(work: () => Promise<void>) {
    if (!live.current || gate.current) return;
    const e = epoch.current;
    gate.current = true;
    setBusy(true);
    setError('');
    try {
      await work();
    } catch (err) {
      if (current(e) && !(err instanceof StaleRead)) setError(problem(err));
    } finally {
      if (current(e)) {
        gate.current = false;
        setBusy(false);
      }
    }
  }
  async function send(attempt: Attempt) {
    if (
      !live.current ||
      gate.current ||
      blocked ||
      readOnly ||
      ((externalBlocked.current || freshBlock.current()) && pendingRef.current !== attempt)
    )
      return;
    const e = epoch.current;
    gate.current = true;
    setBusy(true);
    setError('');
    pendingRef.current = attempt;
    setPending(attempt);
    try {
      const data = await api(attempt.path, 'POST', attempt.body);
      if (!current(e)) return;
      accept(data);
      if (!current(e)) return;
      pendingRef.current = null;
      setPending(null);
      attempt.complete(data);
    } catch (err) {
      if (!current(e)) return;
      if (err instanceof ApiError && [401, 403].includes(err.status)) {
        deny();
        return;
      }
      if (err instanceof ApiError && [400, 404, 409, 413, 422, 423, 429].includes(err.status)) {
        pendingRef.current = null;
        setPending(null);
        rejectRef.current(err.status);
        if (err.status === 423) setBlocked(true);
      }
      setError(problem(err));
    } finally {
      if (current(e)) {
        gate.current = false;
        setBusy(false);
      }
    }
  }
  function mutate(path: string, body: unknown, label: string, complete: Attempt['complete']) {
    if (pendingRef.current || gate.current || blocked || readOnly || externalBlocked.current || freshBlock.current())
      return;
    const serialized = JSON.stringify(body);
    if (new TextEncoder().encode(serialized).byteLength > 2097152) {
      setError('Pełne żądanie przekracza 2 MiB. Nie wysłano ani nie obcięto zakresu.');
      return;
    }
    void send({ path, body: JSON.parse(serialized), label, complete });
  }
  useEffect(() => {
    live.current = true;
    ++epoch.current;
    gate.current = false;
    role.current = null;
    pendingRef.current = null;
    setBusy(false);
    setBlocked(false);
    setPending(null);
    setError('');
    return () => {
      live.current = false;
      ++epoch.current;
      gate.current = false;
      pendingRef.current = null;
    };
  }, [contextKey, readOnly]);
  return {
    get,
    read,
    mutate,
    busy,
    blocked,
    error,
    pending,
    setError,
    locked: busy || blocked || readOnly || !!pending || externalWriteBlocked,
    retry: () => {
      if (pendingRef.current) void send(pendingRef.current);
    },
    deny,
  };
}
type IO = ReturnType<typeof useStocktakeIO>;
function Notice({ io }: { io: IO }) {
  return (
    <>
      {io.error && (
        <p className="wst-error" role="alert">
          {io.error}
        </p>
      )}
      {io.pending && (
        <div className="wst-warning" role="status">
          <strong>{io.pending.label}: wynik nie został potwierdzony.</strong>
          <p>
            Zachowano dokładną treść i klucz tej próby w pamięci panelu. Operacja mogła zostać
            zapisana. Odczytaj wynik albo ponów tę samą próbę. Zamknięcie panelu usuwa ten szkic.
          </p>
          <button
            type="button"
            className="button"
            disabled={io.busy || io.blocked}
            onClick={io.retry}
          >
            Ponów tę samą próbę
          </button>
        </div>
      )}
    </>
  );
}
function Technical({ children }: { children: ReactNode }) {
  return (
    <details className="wst-technical">
      <summary>Identyfikatory techniczne</summary>
      {children}
    </details>
  );
}
type DiscoveryDraft = {
  key: string;
  product_id: string;
  location: string;
  kind: 'existing' | 'new';
  lot_id: string;
  lot_code: string;
  expiry_date: string;
};
type CountDraft = { text: string; line: Line };

export type WmsStocktakesPanelProps = {
  contextKey: string;
  readOnly: boolean;
  refresh?: number;
  onChanged?: () => void;
  warehouseId?: string;
  externalWriteBlocked?: boolean;
  adjustmentsAvailable?: boolean;
  adjustmentsContextKey?: string;
  focusStocktakeId?: string;
  focusToken?: number;
};
type Summary = {
  total: number;
  changed?: number;
  shortage_quantity?: string | number;
  surplus_quantity?: string | number;
  known_loss_minor?: string;
  known_surplus_minor?: string;
  unknown_loss_quantity?: string | number;
};
type Review = {
  id: string;
  stocktake_id: string;
  stocktake_version: string;
  scope_hash: string;
  ready: boolean;
  summary: Summary;
  created_at: string;
};
type ReviewRow = {
  line_id: string;
  product_id: string;
  sku: string;
  name: string;
  location: string;
  lot: Line['lot'];
  counted?: number;
  before?: { quantity: number; reserved: number; basis_hash: string };
  after?: { quantity: number };
  fragments?: {
    layer_id: string | null;
    quantity: number;
    delta: number;
    unit_cost_minor: string | null;
    currency: string;
  }[];
  errors?: string[];
};
type Measurement = {
  id: string;
  stocktake_id: string;
  kind: string;
  created_at: string;
  result: { id: string; stocktake_id: string; version: string; updated: number };
};
type Posting = {
  id: string;
  stocktake_id: string;
  review_id: string;
  wms_operation_id: string;
  state: 'posted';
  changed: boolean;
  summary: Summary;
};
type ReviewResponse = Flags & { review: Review; reused?: boolean };
type PostingResponse = Flags & { posting: Posting | null; reused?: boolean };

function SummaryView({
  summary,
  financial,
  currency,
  exponent,
}: {
  summary: Summary;
  financial: boolean;
  currency: string | null;
  exponent: number;
}) {
  return (
    <div className="wst-stats">
      <span>
        Pozycje: <strong>{summary.total}</strong>
      </span>
      {summary.changed != null && (
        <span>
          Zmiany: <strong>{summary.changed}</strong>
        </span>
      )}
      {financial && (
        <>
          {summary.shortage_quantity != null && (
            <span>
              Niedobór: <strong>{summary.shortage_quantity}</strong> szt.
            </span>
          )}
          {summary.surplus_quantity != null && (
            <span>
              Nadwyżka: <strong>{summary.surplus_quantity}</strong> szt.
            </span>
          )}
          {summary.known_loss_minor != null && (
            <span>
              Znany koszt niedoboru netto:{' '}
              <strong>{currencyText(summary.known_loss_minor, currency, exponent)}</strong>
            </span>
          )}
          {summary.known_surplus_minor != null && (
            <span>
              Koszt nadwyżki netto:{' '}
              <strong>{currencyText(summary.known_surplus_minor, currency, exponent)}</strong>
            </span>
          )}
          {summary.unknown_loss_quantity != null && (
            <span>
              Niedobór o nieznanym koszcie: <strong>{summary.unknown_loss_quantity}</strong> szt.
            </span>
          )}
        </>
      )}
    </div>
  );
}

export function WmsStocktakesPanel(props: WmsStocktakesPanelProps) {
  return <StocktakesScope key={`${props.contextKey}:${props.readOnly}`} {...props} />;
}
function StocktakesScope({
  contextKey,
  readOnly,
  refresh = 0,
  onChanged,
  warehouseId,
  externalWriteBlocked = false,
  adjustmentsAvailable = false,
  adjustmentsContextKey = '',
  focusStocktakeId,
  focusToken,
}: WmsStocktakesPanelProps) {
  const appliedFocus = useRef('');
  const [adjustmentsLocked, setAdjustmentsLocked] = useState(() => stocktakeAdjustmentsLocked(adjustmentsContextKey));
  useEffect(() => subscribeStocktakeAdjustmentsLock(adjustmentsContextKey, setAdjustmentsLocked), [adjustmentsContextKey]);
  const [meta, setMeta] = useState<Metadata | null>(null),
    [flags, setFlags] = useState<Flags | null>(null);
  const [list, setList] = useState<Head[]>([]),
    [listNext, setListNext] = useState<string | null>(null);
  const [listPath, setListPath] = useState<(string | null)[]>([null]);
  const [listWarehouse, setListWarehouse] = useState(warehouseId ?? ''),
    [listLoaded, setListLoaded] = useState(false);
  const [tab, setTab] = useState<'history' | 'create'>('history'),
    [head, setHead] = useState<Head | null>(null);
  const [lines, setLines] = useState<Line[]>([]),
    [linesNext, setLinesNext] = useState<string | null>(null);
  const [linesPath, setLinesPath] = useState<(string | null)[]>([null]);
  const [counts, setCounts] = useState<Record<string, CountDraft>>({}),
    [countNote, setCountNote] = useState('');
  const [basisLines, setBasisLines] = useState<Line[]>([]),
    [basisLoaded, setBasisLoaded] = useState(false);
  const [costs, setCosts] = useState<Record<string, string>>({}),
    [reviewNote, setReviewNote] = useState('');
  const [basisPage, setBasisPage] = useState(0);
  const [review, setReview] = useState<Review | null>(null),
    [reviewRows, setReviewRows] = useState<ReviewRow[]>([]);
  const [reviewLoaded, setReviewLoaded] = useState(false),
    [reviewPage, setReviewPage] = useState(0),
    [consent, setConsent] = useState('');
  const [posting, setPosting] = useState<Posting | null>(null),
    [notice, setNotice] = useState('');
  const [needsReload, setNeedsReload] = useState(false),
    [progress, setProgress] = useState(0);
  const [detailTab, setDetailTab] = useState<'counting' | 'review' | 'history'>('counting');
  const [scanLocked, setScanLocked] = useState(false);
  const [measurements, setMeasurements] = useState<Measurement[]>([]),
    [measurementsNext, setMeasurementsNext] = useState<string | null>(null);
  const [measurementPath, setMeasurementPath] = useState<(string | null)[]>([null]);
  const [reviews, setReviews] = useState<Review[]>([]),
    [reviewsNext, setReviewsNext] = useState<string | null>(null);
  const [reviewsPath, setReviewsPath] = useState<(string | null)[]>([null]);
  const [historyLoaded, setHistoryLoaded] = useState(false),
    [transitionNote, setTransitionNote] = useState('');
  const [createWarehouse, setCreateWarehouse] = useState(warehouseId ?? ''),
    [createName, setCreateName] = useState('');
  const [blind, setBlind] = useState(true),
    [locationPrefix, setLocationPrefix] = useState(''),
    [productText, setProductText] = useState('');
  const [discoveries, setDiscoveries] = useState<DiscoveryDraft[]>([]),
    [createConsent, setCreateConsent] = useState(false);
  const [discoveryPage, setDiscoveryPage] = useState(0);
  const target = useRef(0),
    previousRefresh = useRef(refresh);
  function clearDetail() {
    ++target.current;
    setHead(null);
    setLines([]);
    setLinesNext(null);
    setLinesPath([null]);
    setCounts({});
    setCountNote('');
    setBasisLines([]);
    setBasisLoaded(false);
    setBasisPage(0);
    setCosts({});
    setReviewNote('');
    setReview(null);
    setReviewRows([]);
    setReviewLoaded(false);
    setReviewPage(0);
    setConsent('');
    setPosting(null);
    setNotice('');
    setProgress(0);
    setNeedsReload(false);
    setMeasurements([]);
    setMeasurementsNext(null);
    setMeasurementPath([null]);
    setReviews([]);
    setReviewsNext(null);
    setReviewsPath([null]);
    setHistoryLoaded(false);
    setTransitionNote('');
  }
  function purge() {
    clearDetail();
    setMeta(null);
    setFlags(null);
    setList([]);
    setListNext(null);
    setListLoaded(false);
    setListPath([null]);
    setCreateName('');
    setProductText('');
    setLocationPrefix('');
    setDiscoveries([]);
    setDiscoveryPage(0);
    setCreateConsent(false);
    setBlind(true);
    setCreateWarehouse(warehouseId ?? '');
    setListWarehouse(warehouseId ?? '');
  }
  const io = useStocktakeIO(
    contextKey,
    readOnly,
    purge,
    (status) => {
      setConsent('');
      setCreateConsent(false);
      setBasisLoaded(false);
      setReviewLoaded(false);
      if (status === 409) setNeedsReload(true);
      if (status === 423) {
        setCounts({});
        setCosts({});
        setCountNote('');
        setReviewNote('');
      }
    },
    externalWriteBlocked || adjustmentsLocked,
    () => stocktakeAdjustmentsLocked(adjustmentsContextKey),
  );
  function adopt(data: Flags) {
    setFlags(data);
    if (!data.can_read_value) setCosts({});
  }
  const locked = io.locked || scanLocked,
    financial = flags?.can_read_value === true;
  const showBasis =
    flags?.current_role === 'admin' ||
    (flags?.current_role === 'operator' && head?.blind === false);
  const canCreate = meta?.available && meta.policy.enabled && flags?.can_create && !locked;
  const canCount = flags?.can_count && head?.state === 'counting' && !locked && !needsReload;
  const canReview =
    flags?.can_review && financial && head?.state === 'counting' && !locked && !needsReload;
  const canPost =
    !adjustmentsAvailable && flags?.can_post && financial && head?.state === 'review' && !locked && !needsReload;
  const currency = head?.currency ?? meta?.policy.currency ?? null,
    exponent = meta?.policy.exponent ?? -1;
  const consentScope =
    head && review ? `${head.id}:${head.version}:${review.id}:${review.scope_hash}` : '';
  const draftCount = Object.keys(counts).length;
  const expectedLines = head?.line_count ?? 0;
  const pageLimit = Math.min(100, Math.max(1, meta?.limits.page ?? 100));
  const rowLimit = meta?.limits.positions ?? 10000;
  const surplusLines = basisLines.filter((line) => line.difference != null && line.difference > 0);
  const discoveryPageIndex = Math.min(
    discoveryPage,
    Math.max(0, Math.ceil(discoveries.length / pageLimit) - 1),
  );

  async function metadata() {
    const data = await io.get<Metadata>(prefix + '/metadata');
    adopt(data);
    setMeta(data);
  }
  async function listPage(cursor: string | null, warehouse: string, path: (string | null)[]) {
    const query = new URLSearchParams({ limit: '50' });
    if (cursor) query.set('cursor', cursor);
    if (warehouse) query.set('warehouse_id', warehouse);
    const data = await io.get<Page<Head>>(prefix + '?' + query);
    adopt(data);
    setList(data.data);
    setListNext(data.meta.cursor);
    setListPath(path);
    setListLoaded(true);
  }
  useEffect(() => {
    purge();
    setTab('history');
    void io.read(async () => {
      await metadata();
      await listPage(null, warehouseId ?? '', [null]);
    });
  }, [contextKey, readOnly]);
  useEffect(() => {
    if (previousRefresh.current !== refresh) {
      previousRefresh.current = refresh;
      setNeedsReload(true);
      setConsent('');
    }
  }, [refresh]);

  async function linePage(id: string, cursor: string | null, path: (string | null)[], e: number) {
    const query = new URLSearchParams({ limit: String(pageLimit) });
    if (cursor) query.set('cursor', cursor);
    const data = await io.get<Page<Line>>(prefix + '/' + id + '/lines?' + query);
    if (target.current !== e) throw new StaleRead();
    adopt(data);
    setLines(data.data);
    setLinesNext(data.meta.cursor);
    setLinesPath(path);
  }
  function open(id: string) {
    if (io.busy || io.pending || draftCount || scanLocked) return;
    clearDetail();
    const e = target.current;
    void io.read(async () => {
      const data = await io.get<HeadResponse>(prefix + '/' + id);
      if (target.current !== e) throw new StaleRead();
      adopt(data);
      setHead(data.stocktake);
      setDetailTab(data.stocktake.state === 'counting' ? 'counting' : 'review');
      await linePage(id, null, [null], e);
      if (data.stocktake.state === 'posted') {
        const result = await io.get<PostingResponse>(prefix + '/' + id + '/posting');
        if (target.current !== e) throw new StaleRead();
        adopt(result);
        setPosting(result.posting);
      }
    });
  }
  useEffect(() => {
    const key = `${focusToken ?? 0}:${focusStocktakeId ?? ''}`;
    if (!focusStocktakeId || !uuid.test(focusStocktakeId) || appliedFocus.current === key ||
      !meta?.available || io.busy || io.pending || draftCount || scanLocked) return;
    appliedFocus.current = key;
    setTab('history');
    open(focusStocktakeId);
  }, [focusStocktakeId, focusToken, meta, io.busy, io.pending, draftCount, scanLocked]);
  function reloadDetail() {
    if (!head || io.busy || scanLocked) return;
    const id = head.id,
      e = target.current;
    void io.read(async () => {
      const data = await io.get<HeadResponse>(prefix + '/' + id);
      if (target.current !== e) throw new StaleRead();
      adopt(data);
      setHead(data.stocktake);
      setNeedsReload(false);
      setConsent('');
      setBasisLines([]);
      setBasisLoaded(false);
      setReviewLoaded(false);
      await linePage(id, null, [null], e);
      if (data.stocktake.state === 'posted') {
        const result = await io.get<PostingResponse>(prefix + '/' + id + '/posting');
        if (target.current !== e) throw new StaleRead();
        adopt(result);
        setPosting(result.posting);
      }
    });
  }
  function changeCreate(work: () => void) {
    work();
    setCreateConsent(false);
  }
  function create() {
    try {
      if (!canCreate || !createConsent || !meta) return;
      if (!createWarehouse || !meta.warehouses.some((w) => w.id === createWarehouse))
        throw new Error('Wybierz własny magazyn.');
      const name = boundedText(createName, 'Nazwa inwentaryzacji', 3, 100);
      const ids = productText
        .split(/[\s,;]+/)
        .filter(Boolean)
        .map((id) => id.toLowerCase());
      if (ids.some((id) => !uuid.test(id)))
        throw new Error('Zakres produktów: każdy wpis musi być UUID własnego fizycznego produktu.');
      if (new Set(ids).size !== ids.length)
        throw new Error('Zakres produktów zawiera powtórzone UUID.');
      if (ids.length > rowLimit)
        throw new Error(`Zakres przekracza ${rowLimit} produktów. Niczego nie obcięto.`);
      if (locationPrefix.trim().length > 80)
        throw new Error('Prefix lokalizacji może mieć najwyżej 80 znaków.');
      const discovered = discoveries.map((d) => {
        if (!uuid.test(d.product_id.trim()))
          throw new Error('Znalezisko: podaj UUID własnego produktu.');
        const location = boundedText(d.location, 'Lokalizacja znaleziska', 1, 80);
        if (/[\u0000-\u001f\u007f]/.test(location))
          throw new Error('Lokalizacja nie może zawierać znaków sterujących.');
        if (d.kind === 'existing' && !uuid.test(d.lot_id.trim()))
          throw new Error('Znalezisko: podaj UUID istniejącej partii.');
        const lotCode = d.kind === 'new' ? boundedText(d.lot_code, 'Kod nowej partii', 1, 100) : '';
        return {
          product_id: d.product_id.trim().toLowerCase(),
          location,
          lot:
            d.kind === 'existing'
              ? { kind: 'existing' as const, lot_id: d.lot_id.trim().toLowerCase() }
              : { kind: 'new' as const, lot_code: lotCode, expiry_date: d.expiry_date || null },
        };
      });
      io.mutate(
        prefix,
        {
          client_key: crypto.randomUUID(),
          warehouse_id: createWarehouse,
          name,
          policy_version: meta.policy.version,
          blind,
          ...(locationPrefix.trim() ? { location_prefix: locationPrefix.trim() } : {}),
          ...(ids.length ? { product_ids: ids } : {}),
          ...(discovered.length ? { discoveries: discovered } : {}),
        },
        'Utworzenie spisu',
        (data: HeadResponse) => {
          adopt(data);
          clearDetail();
          setHead(data.stocktake);
          setTab('history');
          setDetailTab('counting');
          setNeedsReload(true);
          setCreateConsent(false);
          setNotice('Spis utworzony. Odczytaj jego zamrożone pozycje przed liczeniem.');
          onChanged?.();
        },
      );
    } catch (err) {
      io.setError(problem(err));
    }
  }
  function editCount(line: Line, text: string) {
    setConsent('');
    setBasisLoaded(false);
    setReviewLoaded(false);
    setCounts((previous) => ({
      ...previous,
      [line.id]: { text, line: previous[line.id]?.line ?? line },
    }));
  }
  function saveCounts() {
    try {
      if (!canCount || !head || !draftCount) return;
      const limit = Math.min(100, meta?.limits.count_batch ?? 100);
      if (draftCount > limit)
        throw new Error(
          `Jedna próba może obejmować najwyżej ${limit} pomiarów. Usuń nadmiarowe szkice; niczego nie obcięto.`,
        );
      const selected = Object.values(counts).map(({ text, line }) => ({
        id: line.id,
        version: line.version,
        basis_token: line.basis_token,
        quantity: integer(text, line.sku + ' / ' + line.location),
      }));
      io.mutate(
        prefix + '/' + head.id + '/counts',
        { client_key: crypto.randomUUID(), note: noteText(countNote), lines: selected },
        'Zapis pomiarów',
        (data: Flags & { measurement: Measurement['result']; reused?: boolean }) => {
          adopt(data);
          setCounts({});
          setCountNote('');
          setConsent('');
          setBasisLoaded(false);
          setReviewLoaded(false);
          setNeedsReload(true);
          setNotice(
            `Zapisano ${data.measurement.updated} pomiarów${data.reused ? ' — potwierdzono tę samą próbę' : ''}. Odczytaj aktualną wersję spisu.`,
          );
          onChanged?.();
        },
      );
    } catch (err) {
      io.setError(problem(err));
    }
  }
  async function allPages<T>(
    path: string,
    identity: (row: T) => string,
    expected: number,
    e: number,
  ) {
    const rows: T[] = [],
      ids = new Set<string>(),
      cursors = new Set<string>();
    let cursor: string | null = null;
    do {
      const query = new URLSearchParams({ limit: String(pageLimit) });
      if (cursor) query.set('cursor', cursor);
      const data: Page<T> = await io.get<Page<T>>(path + '?' + query);
      if (target.current !== e) throw new StaleRead();
      adopt(data);
      for (const row of data.data) {
        const id = identity(row);
        if (ids.has(id))
          throw new Error('API zwróciło powtórzoną pozycję. Pełny zakres nie został potwierdzony.');
        ids.add(id);
        rows.push(row);
      }
      if (rows.length > rowLimit || rows.length > expected)
        throw new Error('Zakres odpowiedzi przekracza zamrożony limit. Nie obcięto pozycji.');
      setProgress(rows.length);
      cursor = data.meta.cursor;
      if (cursor) {
        if (cursors.has(cursor))
          throw new Error('API powtórzyło kursor. Odczyt pełnego zakresu przerwany.');
        cursors.add(cursor);
      }
    } while (cursor);
    if (rows.length !== expected)
      throw new Error(
        `Odczytano ${rows.length} z ${expected} pozycji. Nie można zatwierdzić niepełnego zakresu.`,
      );
    return rows;
  }
  function loadBasis() {
    if (!canReview || !head || draftCount) return;
    const id = head.id,
      version = head.version,
      e = target.current;
    setBasisLoaded(false);
    setConsent('');
    setProgress(0);
    void io.read(async () => {
      const rows = await allPages<Line>(
        prefix + '/' + id + '/lines',
        (row) => row.id,
        expectedLines,
        e,
      );
      const check = await io.get<HeadResponse>(prefix + '/' + id);
      if (target.current !== e) throw new StaleRead();
      adopt(check);
      if (check.stocktake.version !== version)
        throw new Error('Spis zmienił wersję podczas odczytu. Odczytaj go ponownie.');
      setBasisLines(rows);
      setBasisLoaded(true);
      setBasisPage(0);
      setCosts({});
    });
  }
  function createReview() {
    try {
      if (!canReview || !head || !basisLoaded || draftCount) return;
      if (!currency) throw new Error('Brak waluty aktywnej polityki.');
      if (
        basisLines.some((line) => line.counted == null || line.needs_recount || line.scope_changed)
      )
        throw new Error('Przed przeglądem policz wszystkie pozycje i wyjaśnij nieaktualny zakres.');
      if (basisLines.some((line) => line.difference == null))
        throw new Error(
          'Brak uprawnionego porównania ilości. Nie można zgadywać kosztów nadwyżek.',
        );
      const surplus = basisLines
        .filter((line) => line.difference! > 0)
        .map((line) => ({
          line_id: line.id,
          unit_cost_minor: costMinor(costs[line.id] ?? '', exponent),
          currency,
        }));
      io.mutate(
        prefix + '/' + head.id + '/reviews',
        {
          client_key: crypto.randomUUID(),
          version: head.version,
          note: noteText(reviewNote),
          surplus,
        },
        'Przygotowanie przeglądu',
        (data: ReviewResponse) => {
          adopt(data);
          setReview(data.review);
          setReviewRows([]);
          setReviewLoaded(false);
          setConsent('');
          setHead((old) =>
            old
              ? {
                  ...old,
                  state: 'review',
                  version: data.review.stocktake_version,
                  latest_review_id: data.review.id,
                }
              : null,
          );
          setDetailTab('review');
          setBasisLoaded(false);
          setCosts({});
          setReviewNote('');
          setNotice('Przegląd zapisany. Odczytaj wszystkie pozycje planu przed zatwierdzeniem.');
          onChanged?.();
        },
      );
    } catch (err) {
      io.setError(problem(err));
    }
  }
  function loadReview(id: string) {
    if (!head || io.busy || io.pending || draftCount || scanLocked) return;
    const stocktakeId = head.id,
      e = target.current;
    setConsent('');
    setReviewLoaded(false);
    setReviewRows([]);
    setProgress(0);
    setDetailTab('review');
    void io.read(async () => {
      const data = await io.get<ReviewResponse>(prefix + '/' + stocktakeId + '/reviews/' + id);
      if (target.current !== e) throw new StaleRead();
      adopt(data);
      setReview(data.review);
      const rows = await allPages<ReviewRow>(
        prefix + '/' + stocktakeId + '/reviews/' + id + '/rows',
        (row) => row.line_id,
        expectedLines,
        e,
      );
      setReviewRows(rows);
      setReviewLoaded(true);
      setReviewPage(0);
    });
  }
  function post() {
    if (
      !canPost ||
      !head ||
      !review ||
      !reviewLoaded ||
      !review.ready ||
      consent !== consentScope ||
      review.id !== head.latest_review_id ||
      review.stocktake_version !== head.version ||
      reviewRows.some((row) => row.errors?.length)
    )
      return;
    io.mutate(
      prefix + '/' + head.id + '/post',
      {
        client_key: crypto.randomUUID(),
        version: head.version,
        review_id: review.id,
        scope_hash: review.scope_hash,
        confirmed: true,
      },
      'Rozliczenie inwentaryzacji',
      (data: PostingResponse) => {
        adopt(data);
        setPosting(data.posting);
        setConsent('');
        setNeedsReload(true);
        setHead((old) =>
          old ? { ...old, state: 'posted', posting_id: data.posting?.id ?? null } : null,
        );
        setNotice(
          'Inwentaryzacja została rozliczona. Wynik jest lokalnym dokumentem WMS; nie uruchamia wysyłek ani płatności.',
        );
        onChanged?.();
      },
    );
  }
  function transition(action: 'reopen' | 'cancel') {
    try {
      if (!head || locked || needsReload || !flags?.can_create) return;
      io.mutate(
        prefix + '/' + head.id + '/' + action,
        { client_key: crypto.randomUUID(), version: head.version, note: noteText(transitionNote) },
        action === 'reopen' ? 'Ponowne otwarcie liczenia' : 'Anulowanie spisu',
        (data: HeadResponse) => {
          adopt(data);
          setHead(data.stocktake);
          setConsent('');
          setCounts({});
          setCosts({});
          setBasisLoaded(false);
          setReviewLoaded(false);
          setReview(null);
          setReviewRows([]);
          setTransitionNote('');
          setNeedsReload(true);
          setNotice(
            action === 'reopen'
              ? 'Liczenie otwarte ponownie. Odczytaj aktualne pozycje; wcześniejszy przegląd pozostaje w historii.'
              : 'Spis anulowany. Nie zmieniono zapasu.',
          );
          onChanged?.();
        },
      );
    } catch (err) {
      io.setError(problem(err));
    }
  }
  async function measurementPage(
    cursor: string | null,
    path: (string | null)[],
    id: string,
    e: number,
  ) {
    const query = new URLSearchParams({ limit: '50' });
    if (cursor) query.set('cursor', cursor);
    const data = await io.get<Page<Measurement>>(prefix + '/' + id + '/measurements?' + query);
    if (target.current !== e) throw new StaleRead();
    adopt(data);
    setMeasurements(data.data);
    setMeasurementsNext(data.meta.cursor);
    setMeasurementPath(path);
  }
  async function reviewsPage(
    cursor: string | null,
    path: (string | null)[],
    id: string,
    e: number,
  ) {
    const query = new URLSearchParams({ limit: '50' });
    if (cursor) query.set('cursor', cursor);
    const data = await io.get<Page<Review>>(prefix + '/' + id + '/reviews?' + query);
    if (target.current !== e) throw new StaleRead();
    adopt(data);
    setReviews(data.data);
    setReviewsNext(data.meta.cursor);
    setReviewsPath(path);
  }
  function history() {
    if (!head || io.busy || io.pending || scanLocked) return;
    const id = head.id,
      e = target.current;
    setDetailTab('history');
    setHistoryLoaded(false);
    void io.read(async () => {
      await measurementPage(null, [null], id, e);
      await reviewsPage(null, [null], id, e);
      setHistoryLoaded(true);
    });
  }

  return (
    <section className="wms-stocktakes" aria-label="Inwentaryzacja partii WMS">
      <header className="wst-header">
        <div>
          <h2>Inwentaryzacja partii</h2>
          <p className="wst-help">
            Policz rzeczywisty zapas według produktu, lokalizacji i partii. Administrator rozlicza
            różnice po przeglądzie całego planu.
          </p>
        </div>
        <button
          type="button"
          className="button"
          disabled={io.busy}
          onClick={() => void io.read(metadata)}
        >
          Odśwież uprawnienia i politykę
        </button>
      </header>
      <Notice io={io} />
      {externalWriteBlocked && (
        <p className="wst-warning">
          Nowe pomiary i rozliczenia są zablokowane do czasu rozstrzygnięcia importu stanów. Odczyty
          i ponowienie własnej zachowanej próby pozostają dostępne.
        </p>
      )}
      {readOnly || flags?.read_only ? (
        <p className="wst-warning">
          Tryb tylko do odczytu. Pomiary, przeglądy i rozliczenie są wyłączone.
        </p>
      ) : null}
      {!meta ? (
        <p className="wst-help">
          {io.busy ? 'Odczytywanie modułu…' : 'Dane modułu nie zostały odczytane.'}
        </p>
      ) : !meta.available ? (
        <p className="wst-warning">
          Ta kopia nie zawiera modułu inwentaryzacji partii. Wcześniejsze funkcje magazynowe
          pozostają w sekcji Magazyny.
        </p>
      ) : (
        <>
          {!meta.policy.enabled && (
            <p className="wst-warning">
              Śledzenie partii jest wyłączone. Ilościowy spis jest dostępny w Magazynach; nowe spisy
              partii wymagają wcześniejszej jawnej aktywacji WMS. Historia pozostaje czytelna.
            </p>
          )}
          <div className="wst-tabs">
            <button
              type="button"
              className="button"
              aria-pressed={tab === 'history'}
              disabled={io.busy || !!io.pending || scanLocked}
              onClick={() => setTab('history')}
            >
              Spisy i historia
            </button>
            <button
              type="button"
              className="button"
              aria-pressed={tab === 'create'}
              disabled={io.busy || !!io.pending || draftCount > 0 || scanLocked}
              onClick={() => setTab('create')}
            >
              Nowa inwentaryzacja
            </button>
          </div>
          {tab === 'create' ? (
            <div className="wst-card">
              <h3>Utwórz zamrożony zakres</h3>
              <p className="wst-help">
                Jedna inwentaryzacja obejmuje jeden magazyn. W zakresie są wszystkie dodatnie
                pozycje partii z wybranego filtra, także zarezerwowane. Ruch magazynowy pozostaje
                możliwy i może wymagać ponownego liczenia.
              </p>
              <fieldset disabled={!canCreate}>
                <legend>Magazyn i zakres</legend>
                <div className="wst-grid">
                  <label>
                    Własny magazyn
                    <select
                      value={createWarehouse}
                      onChange={(e) => changeCreate(() => setCreateWarehouse(e.target.value))}
                    >
                      <option value="">Wybierz magazyn</option>
                      {meta.warehouses.map((w) => (
                        <option value={w.id} key={w.id}>
                          {w.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Nazwa inwentaryzacji
                    <input
                      value={createName}
                      onChange={(e) => changeCreate(() => setCreateName(e.target.value))}
                    />
                  </label>
                  <label>
                    Prefix lokalizacji — opcjonalnie
                    <input
                      value={locationPrefix}
                      onChange={(e) => changeCreate(() => setLocationPrefix(e.target.value))}
                    />
                  </label>
                  <label className="wst-check">
                    <input
                      type="checkbox"
                      checked={blind}
                      onChange={(e) => changeCreate(() => setBlind(e.target.checked))}
                    />
                    Liczenie w ciemno — operator nie zobaczy oczekiwanych ilości i kosztów.
                  </label>
                  <details className="wst-full">
                    <summary>Jawny zakres produktów — opcjonalnie</summary>
                    <label>
                      UUID fizycznych produktów, oddzielone nową linią
                      <textarea
                        value={productText}
                        onChange={(e) => changeCreate(() => setProductText(e.target.value))}
                      />
                    </label>
                    <p className="wst-help">
                      Puste pole oznacza wszystkie fizyczne produkty objęte filtrem lokalizacji. Nie
                      wybieramy domyślnego produktu ani partii.
                    </p>
                  </details>
                </div>
              </fieldset>
              <fieldset disabled={!canCreate}>
                <legend>Zadeklarowane znaleziska</legend>
                <p className="wst-help">
                  Dodaj znalezioną partię/bin lub znaną pozycję zerową przed utworzeniem spisu.
                  Deklaracja nie przyjmuje towaru; koszt nadwyżki administrator poda w przeglądzie.
                </p>
                {discoveries
                  .slice(discoveryPageIndex * pageLimit, (discoveryPageIndex + 1) * pageLimit)
                  .map((d, pageIndex) => {
                    const index = discoveryPageIndex * pageLimit + pageIndex;
                    return (
                      <div className="wst-card" key={d.key}>
                        <h4>Znalezisko {index + 1}</h4>
                        <div className="wst-grid">
                          <label>
                            UUID produktu
                            <input
                              value={d.product_id}
                              onChange={(e) =>
                                changeCreate(() =>
                                  setDiscoveries((old) =>
                                    old.map((row) =>
                                      row.key === d.key
                                        ? { ...row, product_id: e.target.value }
                                        : row,
                                    ),
                                  ),
                                )
                              }
                            />
                          </label>
                          <label>
                            Lokalizacja
                            <input
                              value={d.location}
                              onChange={(e) =>
                                changeCreate(() =>
                                  setDiscoveries((old) =>
                                    old.map((row) =>
                                      row.key === d.key
                                        ? { ...row, location: e.target.value }
                                        : row,
                                    ),
                                  ),
                                )
                              }
                            />
                          </label>
                          <label>
                            Tożsamość partii
                            <select
                              value={d.kind}
                              onChange={(e) =>
                                changeCreate(() =>
                                  setDiscoveries((old) =>
                                    old.map((row) =>
                                      row.key === d.key
                                        ? { ...row, kind: e.target.value as DiscoveryDraft['kind'] }
                                        : row,
                                    ),
                                  ),
                                )
                              }
                            >
                              <option value="new">Nowa partia</option>
                              <option value="existing">Istniejąca partia</option>
                            </select>
                          </label>
                          {d.kind === 'existing' ? (
                            <label>
                              UUID istniejącej partii
                              <input
                                value={d.lot_id}
                                onChange={(e) =>
                                  changeCreate(() =>
                                    setDiscoveries((old) =>
                                      old.map((row) =>
                                        row.key === d.key
                                          ? { ...row, lot_id: e.target.value }
                                          : row,
                                      ),
                                    ),
                                  )
                                }
                              />
                            </label>
                          ) : (
                            <>
                              <label>
                                Kod nowej partii
                                <input
                                  value={d.lot_code}
                                  onChange={(e) =>
                                    changeCreate(() =>
                                      setDiscoveries((old) =>
                                        old.map((row) =>
                                          row.key === d.key
                                            ? { ...row, lot_code: e.target.value }
                                            : row,
                                        ),
                                      ),
                                    )
                                  }
                                />
                              </label>
                              <label>
                                Termin ważności — opcjonalnie
                                <input
                                  type="date"
                                  value={d.expiry_date}
                                  onChange={(e) =>
                                    changeCreate(() =>
                                      setDiscoveries((old) =>
                                        old.map((row) =>
                                          row.key === d.key
                                            ? { ...row, expiry_date: e.target.value }
                                            : row,
                                        ),
                                      ),
                                    )
                                  }
                                />
                              </label>
                            </>
                          )}
                        </div>
                        <button
                          type="button"
                          className="button"
                          onClick={() =>
                            changeCreate(() =>
                              setDiscoveries((old) => old.filter((row) => row.key !== d.key)),
                            )
                          }
                        >
                          Usuń znalezisko {index + 1}
                        </button>
                      </div>
                    );
                  })}
                <button
                  type="button"
                  className="button"
                  disabled={discoveries.length >= rowLimit}
                  onClick={() =>
                    changeCreate(() => {
                      setDiscoveryPage(Math.floor(discoveries.length / pageLimit));
                      setDiscoveries((old) => [
                        ...old,
                        {
                          key: crypto.randomUUID(),
                          product_id: '',
                          location: '',
                          kind: 'new',
                          lot_id: '',
                          lot_code: '',
                          expiry_date: '',
                        },
                      ]);
                    })
                  }
                >
                  Dodaj znalezisko
                </button>
                {discoveries.length > 0 && (
                  <div className="wst-pages">
                    <button
                      type="button"
                      className="button"
                      disabled={discoveryPageIndex === 0}
                      onClick={() => setDiscoveryPage(discoveryPageIndex - 1)}
                    >
                      Poprzednie znaleziska
                    </button>
                    <span>
                      Strona {discoveryPageIndex + 1}/{Math.ceil(discoveries.length / pageLimit)} ·{' '}
                      {discoveries.length} znalezisk
                    </span>
                    <button
                      type="button"
                      className="button"
                      disabled={(discoveryPageIndex + 1) * pageLimit >= discoveries.length}
                      onClick={() => setDiscoveryPage(discoveryPageIndex + 1)}
                    >
                      Kolejne znaleziska
                    </button>
                  </div>
                )}
                <p className="wst-help">
                  Wszystkie {discoveries.length} deklaracji wejdą do żądania, także z innych stron.
                  Pełny limit wynosi {rowLimit} pozycji; większego zakresu ani żądania ponad 2 MiB
                  nie obcinamy.
                </p>
              </fieldset>
              <label className="wst-check">
                <input
                  type="checkbox"
                  checked={createConsent}
                  disabled={!canCreate}
                  onChange={(e) => setCreateConsent(e.target.checked)}
                />
                Potwierdzam wybrany magazyn, filtr i zadeklarowane znaleziska. Tworzę spis; nie
                zmieniam zapasu.
              </label>
              <button
                type="button"
                className="button primary"
                disabled={!canCreate || !createConsent}
                onClick={create}
              >
                Utwórz inwentaryzację
              </button>
            </div>
          ) : (
            <>
              <div className="wst-card">
                <h3>Spisy i trwała historia</h3>
                <div className="wst-actions">
                  <label>
                    Filtr magazynu
                    <select
                      disabled={io.busy || !!io.pending}
                      value={listWarehouse}
                      onChange={(e) => {
                        setListWarehouse(e.target.value);
                        setListLoaded(false);
                        setList([]);
                        setListNext(null);
                        setListPath([null]);
                      }}
                    >
                      <option value="">Wszystkie własne magazyny</option>
                      {meta.warehouses.map((w) => (
                        <option key={w.id} value={w.id}>
                          {w.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    className="button"
                    disabled={io.busy}
                    onClick={() => void io.read(() => listPage(null, listWarehouse, [null]))}
                  >
                    Odczytaj spisy
                  </button>
                </div>
                {listLoaded && !list.length && (
                  <p className="wst-help" role="status">
                    Odczyt zakończony. Brak spisów w tym zakresie.
                  </p>
                )}
                <div className="wst-list">
                  {list.map((row) => (
                    <button
                      type="button"
                      key={row.id}
                      aria-current={head?.id === row.id}
                      disabled={io.busy || !!io.pending || draftCount > 0 || scanLocked}
                      onClick={() => open(row.id)}
                    >
                      <strong>{row.name}</strong> · {stateName[row.state]} · {row.counted_count}/
                      {row.line_count} policzonych · {date(row.created_at)}
                    </button>
                  ))}
                </div>
                <div className="wst-pages">
                  <button
                    type="button"
                    className="button"
                    disabled={io.busy || !!io.pending || listPath.length < 2}
                    onClick={() => {
                      const previous = listPath.slice(0, -1);
                      void io.read(() => listPage(previous.at(-1)!, listWarehouse, previous));
                    }}
                  >
                    Poprzednia strona spisów
                  </button>
                  <span>Strona {listPath.length}</span>
                  <button
                    type="button"
                    className="button"
                    disabled={io.busy || !!io.pending || !listNext}
                    onClick={() =>
                      void io.read(() => listPage(listNext, listWarehouse, [...listPath, listNext]))
                    }
                  >
                    Kolejna strona spisów
                  </button>
                </div>
              </div>
              {head && (
                <div className="wst-card">
                  <header className="wst-header">
                    <div>
                      <h3>{head.name}</h3>
                      <p>
                        {stateName[head.state]} · wersja {head.version} ·{' '}
                        {meta.warehouses.find((w) => w.id === head.warehouse_id)?.name ??
                          'Własny magazyn'}
                      </p>
                    </div>
                    <button
                      type="button"
                      className="button"
                      disabled={io.busy || scanLocked}
                      onClick={reloadDetail}
                    >
                      Odczytaj aktualny spis
                    </button>
                  </header>
                  <div className="wst-stats">
                    <span>Pozycje: {head.line_count}</span>
                    <span>Policzone: {head.counted_count}</span>
                    <span>Wymagające ponownego pomiaru: {head.needs_recount_count}</span>
                  </div>
                  {needsReload && (
                    <p className="wst-warning">
                      Wersja lub stan mogły się zmienić. Odczytaj aktualny spis przed kolejną
                      operacją. Istniejące szkice zachowują swoją pierwotną podstawę; odczyt nie
                      podmienia ich wersji.
                    </p>
                  )}
                  {notice && (
                    <p className="wst-success" role="status">
                      {notice}
                    </p>
                  )}
                  <Technical>
                    <p>
                      Spis: <code>{head.id}</code>
                    </p>
                    <p>
                      Zakres: <code>{head.scope_hash}</code>
                    </p>
                  </Technical>
                  <StocktakeScans
                    engine="wms"
                    stocktakeId={head.id}
                    contextKey={contextKey}
                    readOnly={readOnly}
                    refresh={refresh}
                    disabled={
                      io.busy ||
                      io.blocked ||
                      readOnly ||
                      !!io.pending ||
                      draftCount > 0 ||
                      ((externalWriteBlocked || adjustmentsLocked) && !scanLocked)
                    }
                    onPendingChange={setScanLocked}
                    onAccessDenied={io.deny}
                    onChanged={() => {
                      setConsent('');
                      setBasisLoaded(false);
                      setReviewLoaded(false);
                      setNeedsReload(true);
                      setNotice(
                        'Zapisano pomiar skanera. Po zakończeniu skanowania odczytaj aktualny spis przed przeglądem lub ręcznym pomiarem.',
                      );
                    }}
                  />
                  <div className="wst-tabs">
                    <button
                      type="button"
                      className="button"
                      aria-pressed={detailTab === 'counting'}
                      disabled={io.busy || !!io.pending || scanLocked}
                      onClick={() => setDetailTab('counting')}
                    >
                      Pomiary
                    </button>
                    <button
                      type="button"
                      className="button"
                      aria-pressed={detailTab === 'review'}
                      disabled={io.busy || !!io.pending || draftCount > 0 || scanLocked}
                      onClick={() => setDetailTab('review')}
                    >
                      Przegląd i rozliczenie
                    </button>
                    <button
                      type="button"
                      className="button"
                      aria-pressed={detailTab === 'history'}
                      disabled={io.busy || !!io.pending || scanLocked}
                      onClick={history}
                    >
                      Historia pomiarów i przeglądów
                    </button>
                  </div>
                  {detailTab === 'counting' && (
                    <>
                      {!showBasis && (
                        <p className="wst-help">
                          Widok pracownika pokazuje identyfikację pozycji i zapisane pomiary. Nie
                          ujawnia podstawy ani kosztów. Puste pole nie jest zerem.
                        </p>
                      )}
                      <div className="wst-scroll">
                        <table className="wst-table">
                          <thead>
                            <tr>
                              <th>Produkt</th>
                              <th>Lokalizacja i partia</th>
                              <th>Zapisany pomiar</th>
                              {showBasis && (
                                <>
                                  <th>Podstawa</th>
                                  <th>Rezerwacja / różnica</th>
                                </>
                              )}
                              <th>Nowy pomiar</th>
                            </tr>
                          </thead>
                          <tbody>
                            {lines.map((line) => (
                              <tr key={line.id}>
                                <td>
                                  <strong>{line.sku}</strong>
                                  <small>{line.name}</small>
                                  <small>Wersja pozycji {line.version}</small>
                                </td>
                                <td>
                                  {line.location}
                                  <small>Partia: {line.lot.lot_code}</small>
                                  {line.lot.expiry_date && (
                                    <small>Termin: {line.lot.expiry_date}</small>
                                  )}
                                </td>
                                <td>
                                  {line.counted == null ? 'Niepoliczona' : `${line.counted} szt.`}
                                  {line.needs_recount && <small>Wymagany ponowny pomiar</small>}
                                  {showBasis &&
                                    line.scope_changed &&
                                    ['counting', 'review'].includes(head.state) && (
                                      <small>
                                        Zmienił się skład partii — anuluj spis i utwórz nowy zakres.
                                      </small>
                                    )}
                                </td>
                                {showBasis && (
                                  <>
                                    <td>
                                      Pierwotnie: {line.original_quantity ?? 'Niedostępne'}
                                      <small>
                                        Bieżąco: {line.current_quantity ?? 'Niedostępne'}
                                      </small>
                                    </td>
                                    <td>
                                      {line.reserved ?? 'Niedostępne'} zarezerwowanych
                                      <small>Różnica: {line.difference ?? 'Brak pomiaru'}</small>
                                    </td>
                                  </>
                                )}
                                <td>
                                  <input
                                    aria-label={`Rzeczywista ilość ${line.sku}, ${line.location}, partia ${line.lot.lot_code}`}
                                    inputMode="numeric"
                                    disabled={!canCount || line.scope_changed}
                                    value={counts[line.id]?.text ?? ''}
                                    onChange={(e) => editCount(line, e.target.value)}
                                  />
                                  {counts[line.id] && (
                                    <>
                                      {(counts[line.id].line.version !== line.version ||
                                        counts[line.id].line.basis_token !== line.basis_token) && (
                                        <small>
                                          Szkic ma wcześniejszą podstawę. Usuń go i ponownie wpisz
                                          pomiar po fizycznym przeliczeniu.
                                        </small>
                                      )}
                                      <button
                                        type="button"
                                        className="button"
                                        disabled={locked}
                                        onClick={() => {
                                          setCounts((old) => {
                                            const next = { ...old };
                                            delete next[line.id];
                                            return next;
                                          });
                                          setConsent('');
                                        }}
                                      >
                                        Usuń szkic
                                      </button>
                                    </>
                                  )}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      <div className="wst-pages">
                        <button
                          type="button"
                          className="button"
                          disabled={io.busy || !!io.pending || linesPath.length < 2}
                          onClick={() => {
                            const previous = linesPath.slice(0, -1);
                            void io.read(() =>
                              linePage(head.id, previous.at(-1)!, previous, target.current),
                            );
                          }}
                        >
                          Poprzednie pozycje
                        </button>
                        <span>Strona {linesPath.length}</span>
                        <button
                          type="button"
                          className="button"
                          disabled={io.busy || !!io.pending || !linesNext}
                          onClick={() =>
                            void io.read(() =>
                              linePage(
                                head.id,
                                linesNext,
                                [...linesPath, linesNext],
                                target.current,
                              ),
                            )
                          }
                        >
                          Kolejne pozycje
                        </button>
                      </div>
                      <label>
                        Uzasadnienie pomiarów
                        <textarea
                          disabled={!canCount}
                          value={countNote}
                          onChange={(e) => setCountNote(e.target.value)}
                        />
                      </label>
                      <div className="wst-actions">
                        <button
                          type="button"
                          className="button primary"
                          disabled={!canCount || !draftCount}
                          onClick={saveCounts}
                        >
                          Zapisz jawne pomiary · {draftCount}
                        </button>
                        <button
                          type="button"
                          className="button"
                          disabled={locked || !draftCount}
                          onClick={() => {
                            setCounts({});
                            setCountNote('');
                            setConsent('');
                          }}
                        >
                          Odrzuć szkice pomiarów
                        </button>
                      </div>
                    </>
                  )}
                  {detailTab === 'review' && (
                    <>
                      {head.state === 'counting' && (
                        <>
                          <p className="wst-help">
                            Przegląd wymaga wszystkich aktualnych pomiarów, również jawnych zer.
                            Nadwyżka tworzy nową warstwę z podanym kosztem netto. Rezerwacje nie są
                            usuwane.
                          </p>
                          <button
                            type="button"
                            className="button"
                            disabled={!canReview || draftCount > 0}
                            onClick={loadBasis}
                          >
                            Odczytaj pełny zakres do przeglądu
                          </button>
                          {io.busy && progress > 0 && (
                            <p role="status">
                              Odczytano {progress}/{expectedLines} pozycji.
                            </p>
                          )}
                          {basisLoaded && (
                            <>
                              <p className="wst-success">
                                Odczytano cały zakres: {basisLines.length} pozycji.
                              </p>
                              {basisLines.some(
                                (line) =>
                                  line.counted == null || line.needs_recount || line.scope_changed,
                              ) && (
                                <p className="wst-warning">
                                  Nie wszystkie pozycje są aktualnie policzone. Wróć do pomiarów;
                                  zmieniony skład partii wymaga nowego spisu.
                                </p>
                              )}
                              {surplusLines
                                .slice(basisPage * pageLimit, (basisPage + 1) * pageLimit)
                                .map((line) => (
                                  <label className="wst-card" key={line.id}>
                                    {line.sku} · {line.location} · partia {line.lot.lot_code}:
                                    nadwyżka {line.difference} szt.
                                    <input
                                      className="wst-cost"
                                      aria-label={`Koszt jednostkowy netto nadwyżki ${line.sku}, ${line.location}, ${line.lot.lot_code}`}
                                      inputMode="decimal"
                                      disabled={!canReview}
                                      value={costs[line.id] ?? ''}
                                      onChange={(e) => {
                                        setCosts((old) => ({ ...old, [line.id]: e.target.value }));
                                        setConsent('');
                                      }}
                                    />
                                    <small>
                                      Koszt jednostkowy netto w {currency}. Puste pole nie oznacza
                                      0.
                                    </small>
                                  </label>
                                ))}
                              {surplusLines.length > 0 && (
                                <div className="wst-pages">
                                  <button
                                    type="button"
                                    className="button"
                                    disabled={locked || basisPage === 0}
                                    onClick={() => setBasisPage((p) => p - 1)}
                                  >
                                    Poprzednie nadwyżki
                                  </button>
                                  <span>
                                    Nadwyżki: strona {basisPage + 1}/
                                    {Math.ceil(surplusLines.length / pageLimit)} ·{' '}
                                    {surplusLines.length} pozycji łącznie
                                  </span>
                                  <button
                                    type="button"
                                    className="button"
                                    disabled={
                                      locked || (basisPage + 1) * pageLimit >= surplusLines.length
                                    }
                                    onClick={() => setBasisPage((p) => p + 1)}
                                  >
                                    Kolejne nadwyżki
                                  </button>
                                </div>
                              )}
                              {!surplusLines.length && (
                                <p className="wst-help">
                                  Brak dodatnich różnic wymagających nowego kosztu.
                                </p>
                              )}
                              <label>
                                Uzasadnienie przeglądu
                                <textarea
                                  disabled={!canReview}
                                  value={reviewNote}
                                  onChange={(e) => {
                                    setReviewNote(e.target.value);
                                    setConsent('');
                                  }}
                                />
                              </label>
                              <button
                                type="button"
                                className="button primary"
                                disabled={!canReview || draftCount > 0}
                                onClick={createReview}
                              >
                                Przygotuj trwały przegląd
                              </button>
                            </>
                          )}
                        </>
                      )}
                      {head.latest_review_id && (
                        <button
                          type="button"
                          className="button"
                          disabled={io.busy || !!io.pending || draftCount > 0 || scanLocked}
                          onClick={() => loadReview(head.latest_review_id!)}
                        >
                          Odczytaj cały ostatni plan
                        </button>
                      )}
                      {review && (
                        <div className="wst-card">
                          <h4>Przegląd z {date(review.created_at)}</h4>
                          <SummaryView
                            summary={review.summary}
                            financial={financial}
                            currency={currency}
                            exponent={exponent}
                          />
                          <p>
                            {review.ready ? 'Plan gotowy' : 'Plan zawiera blokady'} · wersja spisu{' '}
                            {review.stocktake_version}
                          </p>
                          {io.busy && progress > 0 && (
                            <p role="status">
                              Odczytano {progress}/{expectedLines} pozycji planu.
                            </p>
                          )}
                          {reviewLoaded && (
                            <>
                              <p className="wst-help">
                                Odczytano cały zamrożony plan: {reviewRows.length} pozycji.
                                Rozliczenie obejmuje wszystkie pozycje, nie tylko widoczną stronę.
                              </p>
                              <div className="wst-scroll">
                                <table className="wst-table">
                                  <thead>
                                    <tr>
                                      <th>Produkt / partia</th>
                                      <th>Lokalizacja</th>
                                      <th>Pomiar / stan po</th>
                                      {financial && (
                                        <>
                                          <th>Stan przed / rezerwacja</th>
                                          <th>Fragmenty korekty</th>
                                        </>
                                      )}
                                      <th>Blokady</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {reviewRows
                                      .slice(reviewPage * pageLimit, (reviewPage + 1) * pageLimit)
                                      .map((row) => (
                                        <tr key={row.line_id}>
                                          <td>
                                            <strong>{row.sku}</strong>
                                            <small>{row.name}</small>
                                            <small>Partia: {row.lot.lot_code}</small>
                                          </td>
                                          <td>{row.location}</td>
                                          <td>
                                            {row.counted ??
                                              (financial ? row.after?.quantity : undefined) ??
                                              'Niedostępne'}
                                          </td>
                                          {financial && (
                                            <>
                                              <td>
                                                {row.before?.quantity ?? 'Niedostępne'}
                                                <small>
                                                  Rezerwacja:{' '}
                                                  {row.before?.reserved ?? 'Niedostępne'}
                                                </small>
                                              </td>
                                              <td>
                                                <ul className="wst-fragments">
                                                  {row.fragments?.map((fragment, index) => (
                                                    <li key={`${row.line_id}:${index}`}>
                                                      {fragment.delta > 0 ? 'Nadwyżka' : 'Niedobór'}
                                                      : {fragment.quantity} szt. · koszt jednostkowy
                                                      netto{' '}
                                                      {currencyText(
                                                        fragment.unit_cost_minor,
                                                        fragment.currency,
                                                        exponent,
                                                      )}
                                                    </li>
                                                  ))}
                                                </ul>
                                              </td>
                                            </>
                                          )}
                                          <td>
                                            {row.errors?.length ? row.errors.join('; ') : 'Brak'}
                                          </td>
                                        </tr>
                                      ))}
                                  </tbody>
                                </table>
                              </div>
                              <div className="wst-pages">
                                <button
                                  type="button"
                                  className="button"
                                  disabled={reviewPage === 0}
                                  onClick={() => setReviewPage((p) => p - 1)}
                                >
                                  Poprzednia strona planu
                                </button>
                                <span>
                                  Strona {reviewPage + 1}/
                                  {Math.max(1, Math.ceil(reviewRows.length / pageLimit))}
                                </span>
                                <button
                                  type="button"
                                  className="button"
                                  disabled={(reviewPage + 1) * pageLimit >= reviewRows.length}
                                  onClick={() => setReviewPage((p) => p + 1)}
                                >
                                  Kolejna strona planu
                                </button>
                              </div>
                            </>
                          )}
                          <Technical>
                            <p>
                              Przegląd: <code>{review.id}</code>
                            </p>
                            <p>
                              Hash planu: <code>{review.scope_hash}</code>
                            </p>
                          </Technical>
                          {head.state === 'review' && !adjustmentsAvailable && (
                            <>
                              <label className="wst-check">
                                <input
                                  type="checkbox"
                                  disabled={
                                    !canPost ||
                                    !reviewLoaded ||
                                    !review.ready ||
                                    review.id !== head.latest_review_id ||
                                    review.stocktake_version !== head.version ||
                                    reviewRows.some((row) => row.errors?.length)
                                  }
                                  checked={consent === consentScope && consentScope !== ''}
                                  onChange={(e) => setConsent(e.target.checked ? consentScope : '')}
                                />
                                Potwierdzam rozliczenie całego odczytanego planu (
                                {reviewRows.length} pozycji) w tym magazynie, z podanymi kosztami
                                netto i zachowaniem rezerwacji. To lokalna korekta zapasu; nie jest
                                wydaniem klientowi.
                              </label>
                              <button
                                type="button"
                                className="button primary"
                                disabled={
                                  !canPost ||
                                  consent !== consentScope ||
                                  !consentScope ||
                                  !reviewLoaded ||
                                  !review.ready ||
                                  review.id !== head.latest_review_id ||
                                  review.stocktake_version !== head.version ||
                                  reviewRows.some((row) => row.errors?.length)
                                }
                                onClick={post}
                              >
                                Rozlicz cały spis
                              </button>
                            </>
                          )}
                        </div>
                      )}
                      {adjustmentsAvailable && adjustmentsContextKey && head && ['review', 'posted'].includes(head.state) && (
                        <StocktakeAdjustmentsPanel contextKey={adjustmentsContextKey} readOnly={readOnly}
                          sourceKind="wms" stocktakeId={head.id}
                          externalWriteBlocked={externalWriteBlocked || io.busy || Boolean(io.pending) || io.blocked || scanLocked || needsReload}
                          onChanged={() => { setNeedsReload(true); onChanged?.(); }}/>
                      )}
                      {posting && (
                        <div className="wst-success" role="status">
                          <h4>Trwały wynik: rozliczono</h4>
                          <SummaryView
                            summary={posting.summary}
                            financial={financial}
                            currency={currency}
                            exponent={exponent}
                          />
                          <Technical>
                            <p>
                              Wynik: <code>{posting.id}</code>
                            </p>
                            <p>
                              Operacja WMS: <code>{posting.wms_operation_id}</code>
                            </p>
                          </Technical>
                        </div>
                      )}
                      {head.state === 'posted' && !posting && (
                        <button
                          type="button"
                          className="button"
                          disabled={io.busy}
                          onClick={reloadDetail}
                        >
                          Odczytaj trwały wynik
                        </button>
                      )}
                    </>
                  )}
                  {detailTab === 'history' && (
                    <>
                      {!historyLoaded && (
                        <p className="wst-help">
                          {io.busy
                            ? 'Odczytywanie historii…'
                            : 'Odczytaj historię pomiarów i przeglądów.'}
                        </p>
                      )}
                      <h4>Pomiary</h4>
                      {historyLoaded && !measurements.length && (
                        <p className="wst-help">Brak zapisanych pomiarów.</p>
                      )}
                      <div className="wst-list">
                        {measurements.map((m) => (
                          <div className="wst-card" key={m.id}>
                            <strong>{date(m.created_at)}</strong> ·{' '}
                            {m.kind === 'count'
                              ? `Pomiar: ${m.result.updated} zapisanych pozycji`
                              : m.kind === 'reopen'
                                ? 'Ponowne otwarcie liczenia'
                                : m.kind === 'cancel'
                                  ? 'Anulowanie spisu'
                                  : 'Zapis operacji'}{' '}
                            · wersja {m.result.version}
                            <Technical>
                              <code>{m.id}</code>
                            </Technical>
                          </div>
                        ))}
                      </div>
                      <div className="wst-pages">
                        <button
                          type="button"
                          className="button"
                          disabled={io.busy || !!io.pending || measurementPath.length < 2}
                          onClick={() => {
                            const previous = measurementPath.slice(0, -1);
                            void io.read(() =>
                              measurementPage(previous.at(-1)!, previous, head.id, target.current),
                            );
                          }}
                        >
                          Poprzednia strona pomiarów
                        </button>
                        <span>Strona {measurementPath.length}</span>
                        <button
                          type="button"
                          className="button"
                          disabled={io.busy || !!io.pending || !measurementsNext}
                          onClick={() =>
                            void io.read(() =>
                              measurementPage(
                                measurementsNext,
                                [...measurementPath, measurementsNext],
                                head.id,
                                target.current,
                              ),
                            )
                          }
                        >
                          Kolejna strona pomiarów
                        </button>
                      </div>
                      <h4>Przeglądy</h4>
                      {historyLoaded && !reviews.length && (
                        <p className="wst-help">Brak zapisanych przeglądów.</p>
                      )}
                      <div className="wst-list">
                        {reviews.map((r) => (
                          <button
                            type="button"
                            className="button"
                            key={r.id}
                            disabled={io.busy || !!io.pending || draftCount > 0 || scanLocked}
                            onClick={() => loadReview(r.id)}
                          >
                            {date(r.created_at)} · wersja {r.stocktake_version} ·{' '}
                            {r.ready ? 'Gotowy plan' : 'Blokady'} · {r.summary.total} pozycji
                          </button>
                        ))}
                      </div>
                      <div className="wst-pages">
                        <button
                          type="button"
                          className="button"
                          disabled={io.busy || !!io.pending || reviewsPath.length < 2}
                          onClick={() => {
                            const previous = reviewsPath.slice(0, -1);
                            void io.read(() =>
                              reviewsPage(previous.at(-1)!, previous, head.id, target.current),
                            );
                          }}
                        >
                          Poprzednia strona przeglądów
                        </button>
                        <span>Strona {reviewsPath.length}</span>
                        <button
                          type="button"
                          className="button"
                          disabled={io.busy || !!io.pending || !reviewsNext}
                          onClick={() =>
                            void io.read(() =>
                              reviewsPage(
                                reviewsNext,
                                [...reviewsPath, reviewsNext],
                                head.id,
                                target.current,
                              ),
                            )
                          }
                        >
                          Kolejna strona przeglądów
                        </button>
                      </div>
                    </>
                  )}
                  {['counting', 'review'].includes(head.state) && flags?.can_create && (
                    <fieldset disabled={locked || needsReload}>
                      <legend>Zarządzanie spisem</legend>
                      <label>
                        Uzasadnienie ponownego otwarcia lub anulowania
                        <textarea
                          value={transitionNote}
                          onChange={(e) => {
                            setTransitionNote(e.target.value);
                            setConsent('');
                          }}
                        />
                      </label>
                      <div className="wst-actions">
                        {head.state === 'review' && (
                          <button
                            type="button"
                            className="button"
                            onClick={() => transition('reopen')}
                          >
                            Otwórz liczenie ponownie
                          </button>
                        )}
                        <button
                          type="button"
                          className="button"
                          onClick={() => transition('cancel')}
                        >
                          Anuluj spis bez zmiany zapasu
                        </button>
                      </div>
                    </fieldset>
                  )}
                </div>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
