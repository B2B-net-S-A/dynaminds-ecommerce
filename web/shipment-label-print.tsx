import { useEffect, useRef, useState } from 'react';
import { api, ApiError, date } from './api';
import { PrintLabelPdfPreview } from './print-label-pdf-preview';
import {
  checkPrintJobFlags,
  checkPrintJobHead,
  checkPrintJobPrinter,
  getPrintJobsMutationState,
  performShipmentLabelPrintWrite,
  purgePrintJobsAccess,
  resetPrintJobsContext,
  subscribePrintJobsLock,
  validPrintVersion,
  verifyPrintJobsActor,
  type PrintJobHead,
  type PrintJobOptions,
  type PrintJobPrinter,
  type PrintJobStation,
  type PrintJobWriteReply,
  type PrintWriteAttempt,
} from './print-jobs';
import './shipment-label-print.css';

export type ShipmentLabelPrintProps = {
  contextKey: string;
  readOnly: boolean;
  orderId: string;
  shipmentId: string;
  externalWriteBlocked?: boolean;
  onClose: () => void;
};
type Preview = {
  id: string;
  shipment_id: string;
  order_id: string;
  source_kind: 'dpd_cached' | 'demo_generated' | 'inpost_cached';
  source_snapshot: {
    carrier: string;
    mode: string;
    tracking_number: string;
    shipping_plan_id: string | null;
    source_hash: string;
    cache_asset_id?: string;
  };
  order_snapshot: { id: string; number: string; version: string };
  station_snapshot: PrintJobStation;
  printer_snapshot: PrintJobPrinter;
  copies: number;
  format: 'pdf';
  content_sha256: string;
  content_bytes: number;
  scope_hash: string;
  created_at: string;
  expires_at: string;
  queued_job_id: string | null;
  can_queue: boolean;
};
type Options = PrintJobOptions;
type LabelCache = {
  id: string;
  shipment_id: string;
  order_id: string;
  provider: 'inpost' | 'dpd';
  mode: string;
  tracking_number: string;
  shipping_plan_id: string | null;
  format: 'pdf';
  layout: 'A6' | 'A4';
  content_sha256: string;
  content_bytes: number;
  source_hash: string;
  acquisition_id: string;
  origin: 'provider_get' | 'legacy_dpd_cache';
  created_at: string;
};
type Acquisition = {
  id: string;
  shipment_id: string;
  state: 'fetching' | 'ready' | 'failed' | 'unknown' | 'abandoned';
  asset_id: string | null;
  source_hash: string;
  created_at: string;
  updated_at: string;
  error_code: string | null;
  can_reconcile: boolean;
};
type CacheReply = PrintJobWriteReply & { cache: LabelCache | null; acquisition: Acquisition };
type CacheMetadata = PrintJobWriteReply & {
  cache: LabelCache | null;
  latest_acquisition: Acquisition | null;
  source_hash: string | null;
  order_version: string | null;
  can_acquire: boolean;
  can_queue: boolean;
  unavailable_reason: string | null;
};
type CacheHistoryReply = PrintJobWriteReply & { data: Acquisition[]; next_cursor: string | null };
type PreviewReply = PrintJobWriteReply & { preview: Preview };
type ContentReply = PrintJobWriteReply & {
  preview_id: string;
  format: 'pdf';
  content_base64: string;
  content_sha256: string;
  content_bytes: number;
};
const uuid = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
const sha = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const sourceNames = {
  dpd_cached: 'Zapisana etykieta DPD',
  inpost_cached: 'Zapisana etykieta InPost',
  demo_generated: 'Etykieta DEMO wygenerowana lokalnie',
};
const stateNames: Record<string, string> = {
  queued: 'W kolejce',
  claimed: 'Przejęte przez wykonawcę',
  file_saved: 'Plik zapisany lokalnie',
  spool_submitted: 'Przekazane do CUPS',
  failed: 'Błąd',
  unknown: 'Wynik nieznany',
  cancelled: 'Anulowane',
};
const acquisitionNames: Record<Acquisition['state'], string> = {
  fetching: 'Pobieranie rozpoczęte',
  ready: 'Plik zapisany w cache',
  failed: 'Pobranie nie powiodło się',
  unknown: 'Wynik pobrania nieznany',
  abandoned: 'Próba zamknięta bez pliku',
};
function checkCache(c: LabelCache, orderId: string, shipmentId: string) {
  if (
    !c ||
    !uuid(c.id) ||
    c.order_id !== orderId ||
    c.shipment_id !== shipmentId ||
    !['inpost', 'dpd'].includes(c.provider) ||
    !['sandbox', 'live'].includes(c.mode) ||
    !c.tracking_number ||
    (c.shipping_plan_id !== null && !uuid(c.shipping_plan_id)) ||
    c.format !== 'pdf' ||
    !['A6', 'A4'].includes(c.layout) ||
    !sha(c.content_sha256) ||
    !sha(c.source_hash) ||
    !uuid(c.acquisition_id) ||
    !Number.isSafeInteger(c.content_bytes) ||
    c.content_bytes < 1 ||
    c.content_bytes > 2097152 ||
    !['provider_get', 'legacy_dpd_cache'].includes(c.origin) ||
    !Number.isFinite(Date.parse(c.created_at))
  )
    throw Error('Niepełny zapis etykiety tej przesyłki.');
}
function checkAcquisition(a: Acquisition, shipmentId: string) {
  if (
    !a ||
    !uuid(a.id) ||
    a.shipment_id !== shipmentId ||
    !Object.hasOwn(acquisitionNames, a.state) ||
    (a.asset_id !== null && !uuid(a.asset_id)) ||
    !sha(a.source_hash) ||
    typeof a.can_reconcile !== 'boolean' ||
    (a.error_code !== null && typeof a.error_code !== 'string') ||
    (a.can_reconcile && !['fetching', 'unknown'].includes(a.state)) ||
    !Number.isFinite(Date.parse(a.created_at)) ||
    !Number.isFinite(Date.parse(a.updated_at)) ||
    (a.state === 'ready' && !a.asset_id)
  )
    throw Error('Niepełna trwała próba pobrania etykiety.');
}
function checkCacheReply(r: CacheReply, orderId: string, shipmentId: string) {
  checkPrintJobFlags(r);
  checkAcquisition(r.acquisition, shipmentId);
  if (r.cache) {
    checkCache(r.cache, orderId, shipmentId);
    if (
      r.cache.id !== r.acquisition.asset_id ||
      r.cache.source_hash !== r.acquisition.source_hash ||
      r.acquisition.state !== 'ready'
    )
      throw Error('Zapis etykiety nie odpowiada trwałej próbie pobrania.');
  } else if (r.acquisition.state === 'ready') throw Error('Brak pliku zakończonego pobrania.');
}
function checkCacheMetadata(r: CacheMetadata, orderId: string, shipmentId: string) {
  checkPrintJobFlags(r);
  if (
    typeof r.can_acquire !== 'boolean' ||
    typeof r.can_queue !== 'boolean' ||
    (r.source_hash !== null && !sha(r.source_hash)) ||
    (r.order_version !== null && !validPrintVersion(r.order_version)) ||
    (r.unavailable_reason !== null && typeof r.unavailable_reason !== 'string') ||
    (r.can_acquire && (!r.available || !r.source_hash || !r.order_version))
  )
    throw Error('Niepełny odczyt dostępności etykiety.');
  if (r.cache) checkCache(r.cache, orderId, shipmentId);
  if (r.latest_acquisition) checkAcquisition(r.latest_acquisition, shipmentId);
}

function checkPreview(p: Preview, orderId: string, shipmentId: string) {
  if (
    !p ||
    !uuid(p.id) ||
    p.order_id !== orderId ||
    p.shipment_id !== shipmentId ||
    !Object.hasOwn(sourceNames, p.source_kind) ||
    p.format !== 'pdf' ||
    !sha(p.scope_hash) ||
    !sha(p.content_sha256) ||
    !Number.isSafeInteger(p.content_bytes) ||
    p.content_bytes < 1 ||
    p.content_bytes > 2097152 ||
    !Number.isInteger(p.copies) ||
    p.copies < 1 ||
    p.copies > 10 ||
    typeof p.can_queue !== 'boolean' ||
    (p.queued_job_id !== null && !uuid(p.queued_job_id)) ||
    !Number.isFinite(Date.parse(p.expires_at)) ||
    !Number.isFinite(Date.parse(p.created_at))
  )
    throw Error('Niepełny trwały podgląd etykiety tej przesyłki.');
  checkPrintJobPrinter(p.printer_snapshot);
  const s = p.source_snapshot,
    station = p.station_snapshot;
  if (
    !s ||
    !s.carrier ||
    !s.tracking_number ||
    !['demo', 'sandbox', 'live'].includes(s.mode) ||
    !sha(s.source_hash) ||
    (s.cache_asset_id !== undefined && !uuid(s.cache_asset_id)) ||
    (s.shipping_plan_id !== null && !uuid(s.shipping_plan_id)) ||
    p.order_snapshot?.id !== orderId ||
    !p.order_snapshot.number ||
    !validPrintVersion(p.order_snapshot.version) ||
    !uuid(station?.id) ||
    !validPrintVersion(station.version) ||
    !station.label ||
    p.printer_snapshot.station_id !== station.id ||
    p.printer_snapshot.format !== p.format
  )
    throw Error('Pochodzenie, zamówienie lub drukarka nie odpowiadają podglądowi etykiety.');
}
function samePreview(a: Preview, b: Preview) {
  return (
    a.id === b.id &&
    a.scope_hash === b.scope_hash &&
    a.content_sha256 === b.content_sha256 &&
    a.content_bytes === b.content_bytes &&
    a.order_id === b.order_id &&
    a.shipment_id === b.shipment_id &&
    a.source_snapshot.cache_asset_id === b.source_snapshot.cache_asset_id &&
    a.printer_snapshot.id === b.printer_snapshot.id &&
    a.printer_snapshot.version === b.printer_snapshot.version &&
    a.station_snapshot.id === b.station_snapshot.id &&
    a.station_snapshot.version === b.station_snapshot.version &&
    a.copies === b.copies
  );
}
async function validateReply(reply: PrintJobWriteReply, attempt: PrintWriteAttempt) {
  const [orderId, shipmentId] = (attempt.owner ?? '').split(':');
  if (!uuid(orderId) || !uuid(shipmentId)) throw Error('Nieprawidłowy zachowany zakres przesyłki.');
  const b = JSON.parse(attempt.body);
  if (attempt.kind === 'label_preview') {
    const p = reply.preview as Preview;
    checkPreview(p, orderId, shipmentId);
    if (
      attempt.path !== `/print-jobs/shipments/${shipmentId}/label-previews` ||
      p.order_snapshot.version !== b.order_version ||
      p.station_snapshot.id !== b.station_id ||
      p.station_snapshot.version !== b.station_version ||
      p.printer_snapshot.id !== b.printer_id ||
      p.printer_snapshot.version !== b.printer_version ||
      p.copies !== b.copies ||
      (b.asset_id !== undefined && p.source_snapshot.cache_asset_id !== b.asset_id)
    )
      throw Error('Podgląd nie odpowiada dokładnej zachowanej próbie.');
    if (b.asset_id !== undefined) {
      const cache = attempt.evidence as LabelCache;
      checkCache(cache, orderId, shipmentId);
      if (
        cache.id !== b.asset_id ||
        p.content_sha256 !== cache.content_sha256 ||
        p.content_bytes !== cache.content_bytes ||
        p.source_snapshot.source_hash !== cache.source_hash ||
        p.source_kind !== (cache.provider === 'inpost' ? 'inpost_cached' : 'dpd_cached')
      )
        throw Error('Podgląd nie zawiera dokładnego wybranego pliku etykiety.');
    }
  } else if (attempt.kind === 'label_queue') {
    const p = attempt.evidence as Preview;
    checkPreview(p, orderId, shipmentId);
    const j = reply.job!;
    checkPrintJobHead(j);
    if (
      attempt.path !== `/print-jobs/label-previews/${p.id}/queue` ||
      b.scope_hash !== p.scope_hash ||
      reply.preview_id !== p.id ||
      j.source_kind !== 'shipment_label' ||
      j.order_id !== orderId ||
      j.order_snapshot.version !== p.order_snapshot.version ||
      j.printer_id !== p.printer_snapshot.id ||
      j.printer_snapshot.version !== p.printer_snapshot.version ||
      j.station_id !== p.station_snapshot.id ||
      j.station_snapshot.version !== p.station_snapshot.version ||
      j.copies !== p.copies ||
      j.format !== p.format ||
      j.content_sha256 !== p.content_sha256 ||
      j.content_bytes !== p.content_bytes
    )
      throw Error('Zadanie nie odpowiada zamrożonemu plikowi i konfiguracji podglądu.');
  } else if (attempt.kind === 'label_cache' || attempt.kind === 'label_cache_reconcile') {
    const r = reply as CacheReply;
    checkCacheReply(r, orderId, shipmentId);
    if (attempt.kind === 'label_cache') {
      if (
        attempt.path !== `/print-jobs/shipments/${shipmentId}/label-cache` ||
        r.acquisition.source_hash !== b.source_hash ||
        b.confirmed_existing_label !== true
      )
        throw Error('Pobranie nie odpowiada dokładnej zachowanej próbie.');
    } else if (
      attempt.path !== `/print-jobs/label-cache/acquisitions/${r.acquisition.id}/reconcile` ||
      b.confirmed_abandon !== true ||
      r.acquisition.state !== 'abandoned'
    )
      throw Error('Zamknięcie nie odpowiada trwałej próbie pobrania.');
  } else throw Error('Nieprawidłowy rodzaj próby etykiety.');
}

export function ShipmentLabelPrintPanel(props: ShipmentLabelPrintProps) {
  const identity = `${props.contextKey}:${props.readOnly}:${props.orderId}:${props.shipmentId}`;
  const owner = `${props.orderId}:${props.shipmentId}`;
  const scope = useRef(identity);
  scope.current = identity;
  const liveProps = useRef(props);
  liveProps.current = props;
  const alive = useRef(false),
    generation = useRef(0),
    seenOutcome = useRef<PrintJobWriteReply | null>(null);
  const [, redraw] = useState(0);
  const [options, setOptions] = useState<Options | null>(null),
    [printers, setPrinters] = useState<PrintJobPrinter[]>([]);
  const [cacheMetadata, setCacheMetadata] = useState<CacheMetadata | null>(null);
  const [cacheDetail, setCacheDetail] = useState<CacheReply | null>(null);
  const cacheCursors = useRef(new Set<string>());
  const [cacheHistory, setCacheHistory] = useState<Acquisition[]>([]),
    [cacheCursor, setCacheCursor] = useState<string | null>(null),
    [cacheHistoryRead, setCacheHistoryRead] = useState(false);
  const [cacheConsent, setCacheConsent] = useState(false),
    [abandonId, setAbandonId] = useState(''),
    [abandonConsent, setAbandonConsent] = useState(false);
  const [loaded, setLoaded] = useState(''),
    [loadedEpoch, setLoadedEpoch] = useState(-1),
    [reading, setReading] = useState(false);
  const [stationId, setStationId] = useState(''),
    [printerId, setPrinterId] = useState(''),
    [copies, setCopies] = useState('1');
  const [order, setOrder] = useState<{ id: string; number: string; version: string } | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null),
    [contentRead, setContentRead] = useState<string | null>(null),
    [job, setJob] = useState<PrintJobHead | null>(null);
  const [pdfContent, setPdfContent] = useState<{
    identity: string;
    epoch: number;
    previewId: string;
    sha256: string;
    data: Uint8Array;
  } | null>(null);
  const [pdfReady, setPdfReady] = useState<{
    identity: string;
    epoch: number;
    previewId: string;
    sha256: string;
  } | null>(null);
  const [consent, setConsent] = useState(false),
    [retryConsent, setRetryConsent] = useState(false),
    [now, setNow] = useState(Date.now());
  const [error, setError] = useState(''),
    [success, setSuccess] = useState('');
  const io = getPrintJobsMutationState(props.contextKey);
  const current = (n: number, e: number, id = identity) =>
    alive.current &&
    generation.current === n &&
    scope.current === id &&
    getPrintJobsMutationState(props.contextKey).active &&
    getPrintJobsMutationState(props.contextKey).epoch === e;
  const visible = loaded === identity && loadedEpoch === io.epoch;
  const writable =
    visible && !!options?.available && !!options.can_write && !options.read_only && !props.readOnly;
  const busy = reading || io.inFlight;
  const freshBlocked = !!props.externalWriteBlocked || !writable || busy || io.locked;
  const renderedPdf =
    !!preview &&
    !!pdfContent &&
    !!pdfReady &&
    pdfContent.identity === identity &&
    pdfContent.epoch === io.epoch &&
    pdfContent.previewId === preview.id &&
    pdfContent.sha256 === preview.content_sha256 &&
    pdfReady.identity === identity &&
    pdfReady.epoch === io.epoch &&
    pdfReady.previewId === preview.id &&
    pdfReady.sha256 === preview.content_sha256;
  const ownPending =
    io.pending?.owner === owner &&
    ['label_preview', 'label_queue', 'label_cache', 'label_cache_reconcile'].includes(
      io.pending.kind,
    )
      ? io.pending
      : null;
  function invalidate() {
    setPreview(null);
    setContentRead(null);
    setPdfContent(null);
    setPdfReady(null);
    setConsent(false);
    setSuccess('');
  }
  function purge() {
    setCacheMetadata(null);
    setCacheDetail(null);
    setCacheHistory([]);
    setCacheCursor(null);
    setCacheHistoryRead(false);
    cacheCursors.current.clear();
    setCacheConsent(false);
    setAbandonId('');
    setAbandonConsent(false);
    setOptions(null);
    setPrinters([]);
    setOrder(null);
    setPreview(null);
    setJob(null);
    setContentRead(null);
    setPdfContent(null);
    setPdfReady(null);
    setConsent(false);
    setRetryConsent(false);
    setStationId('');
    setPrinterId('');
    setCopies('1');
  }
  function fail(err: unknown) {
    if (err instanceof ApiError && [401, 403].includes(err.status)) {
      purgePrintJobsAccess(props.contextKey);
      purge();
    }
    if (err instanceof ApiError && err.status === 503) purge();
    setError(err instanceof Error ? err.message : 'Nie udało się odczytać etykiety.');
  }
  async function access(): Promise<Options> {
    const e = getPrintJobsMutationState(props.contextKey).epoch;
    await verifyPrintJobsActor(props.contextKey);
    const r = await api<Options>('/print-jobs/shipment-labels/options');
    checkPrintJobFlags(r);
    if (r.available && !r.can_read) throw new ApiError('Brak bieżącego dostępu do etykiet.', 403);
    if (
      r.available &&
      (!Array.isArray(r.stations) ||
        r.stations.length > 100 ||
        new Set(r.stations.map((s) => s.id)).size !== r.stations.length ||
        r.stations.some(
          (s) => !uuid(s.id) || !validPrintVersion(s.version) || typeof s.enabled !== 'boolean',
        ))
    )
      throw Error('Niepełna lista własnych stanowisk.');
    await verifyPrintJobsActor(props.contextKey);
    if (
      alive.current &&
      scope.current === identity &&
      getPrintJobsMutationState(props.contextKey).active &&
      getPrintJobsMutationState(props.contextKey).epoch === e
    )
      setOptions(r);
    return r;
  }
  async function read<T>(run: (o: Options) => Promise<T>): Promise<T | null> {
    if (reading || getPrintJobsMutationState(props.contextKey).inFlight) return null;
    const n = ++generation.current,
      e = getPrintJobsMutationState(props.contextKey).epoch,
      id = identity;
    setReading(true);
    setError('');
    try {
      const o = await access();
      if (!current(n, e, id)) return null;
      const value = await run(o),
        last = await access();
      if (!current(n, e, id)) return null;
      setOptions(last);
      setLoaded(id);
      setLoadedEpoch(e);
      return value;
    } catch (err) {
      if (current(n, e, id)) fail(err);
      return null;
    } finally {
      if (alive.current && scope.current === id && generation.current === n) setReading(false);
    }
  }
  async function allPrinters(o: Options) {
    const rows: PrintJobPrinter[] = [],
      cursors = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; page < 3; page++) {
      const r: PrintJobOptions & { printers: PrintJobPrinter[]; next_cursor: string | null } =
        await api('/print-jobs/printers' + (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''));
      checkPrintJobFlags(r);
      if (
        !r.available ||
        !r.can_read ||
        r.current_role !== o.current_role ||
        r.read_only !== o.read_only ||
        r.can_write !== o.can_write ||
        r.can_manage !== o.can_manage ||
        !Array.isArray(r.printers) ||
        r.printers.length > 50 ||
        (r.next_cursor !== null && (!uuid(r.next_cursor) || cursors.has(r.next_cursor)))
      )
        throw Error('Dostęp lub kompletność listy drukarek zmieniły się.');
      for (const p of r.printers) {
        checkPrintJobPrinter(p);
        if (rows.some((v) => v.id === p.id)) throw Error('Powtórzona drukarka na liście.');
        rows.push(p);
      }
      if (rows.length > 100) throw Error('Przekroczony zakres drukarek.');
      if (!r.next_cursor) return rows;
      if (!r.printers.length) throw Error('Niepełna strona drukarek.');
      cursors.add(r.next_cursor);
      cursor = r.next_cursor;
    }
    throw Error('Nie udało się odczytać całej listy drukarek.');
  }
  async function load() {
    const result = await read(async (o) => {
      if (!o.available) return { printers: [], order: null, cacheMetadata: null };
      if (!uuid(props.orderId) || !uuid(props.shipmentId))
        throw Error('Nieprawidłowy zakres własnej przesyłki.');
      const ps = await allPrinters(o);
      const order = await api<{
        id: string;
        number: string;
        version: string | number;
        shipments: Array<{ id: string }>;
      }>('/orders/' + props.orderId);
      const version = String(order.version);
      if (
        order.id !== props.orderId ||
        !order.number ||
        !validPrintVersion(version) ||
        (typeof order.version === 'number' && !Number.isSafeInteger(order.version)) ||
        !Array.isArray(order.shipments) ||
        !order.shipments.some((s) => s.id === props.shipmentId)
      )
        throw Error('Przesyłka nie należy do tego własnego zamówienia.');
      const metadata = await api<CacheMetadata>(
        `/print-jobs/shipments/${props.shipmentId}/label-cache`,
      );
      checkCacheMetadata(metadata, props.orderId, props.shipmentId);
      if (metadata.available && !metadata.can_read)
        throw new ApiError('Brak dostępu do zapisanej etykiety.', 403);
      if (metadata.order_version !== null && metadata.order_version !== version)
        throw new ApiError(
          'Wersja zamówienia zmieniła się podczas odczytu etykiety. Odczytaj ponownie.',
          409,
        );
      return {
        printers: ps,
        order: { id: order.id, number: order.number, version },
        cacheMetadata: metadata,
      };
    });
    if (result) {
      setPrinters(result.printers);
      setOrder(result.order);
      setCacheMetadata(result.cacheMetadata);
      setCacheConsent(false);
      setAbandonConsent(false);
      setConsent(false);
    }
  }
  async function loadCacheHistory(append = false) {
    const cursor = append ? cacheCursor : null;
    if (append && !cursor) return;
    const r = await read(async (o) => {
      const page = await api<CacheHistoryReply>(
        `/print-jobs/shipments/${props.shipmentId}/label-cache/history?limit=50` +
          (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''),
      );
      checkPrintJobFlags(page);
      if (
        !page.available ||
        !page.can_read ||
        page.current_role !== o.current_role ||
        page.read_only !== o.read_only ||
        page.can_write !== o.can_write ||
        page.can_manage !== o.can_manage
      )
        throw new ApiError('Dostęp do historii pobrań zmienił się. Odczytaj dostęp ponownie.', 403);
      if (
        !Array.isArray(page.data) ||
        page.data.length > 50 ||
        new Set(page.data.map((a) => a.id)).size !== page.data.length ||
        (page.next_cursor !== null &&
          (!uuid(page.next_cursor) ||
            page.next_cursor === cursor ||
            (append && cacheCursors.current.has(page.next_cursor)))) ||
        (page.next_cursor !== null && !page.data.length)
      )
        throw Error('Niepełna strona historii pobrań.');
      page.data.forEach((a) => checkAcquisition(a, props.shipmentId));
      if (
        append &&
        (cacheHistory.length + page.data.length > 2000 ||
          page.data.some((a) => cacheHistory.some((old) => old.id === a.id)))
      )
        throw Error('Powtórzony lub przekroczony zakres historii pobrań.');
      return page;
    });
    if (r) {
      if (!append) cacheCursors.current.clear();
      if (r.next_cursor) cacheCursors.current.add(r.next_cursor);
      setCacheHistory(append ? [...cacheHistory, ...r.data] : r.data);
      setCacheCursor(r.next_cursor);
      setCacheHistoryRead(true);
    }
  }
  async function loadCacheDetail(id: string) {
    if (!uuid(id)) return;
    setCacheDetail(null);
    const r = await read(async () => {
      const detail = await api<CacheReply>(`/print-jobs/label-cache/${id}`);
      checkCacheReply(detail, props.orderId, props.shipmentId);
      if (!detail.available || !detail.can_read)
        throw new ApiError('Brak dostępu do zapisanego pliku.', 403);
      if (detail.cache?.id !== id) throw Error('Odczytano inny zapis etykiety.');
      return detail;
    });
    if (r) setCacheDetail(r);
  }
  async function loadPreview(id: string) {
    if (!uuid(id)) return;
    setConsent(false);
    setContentRead(null);
    setPdfContent(null);
    setPdfReady(null);
    const result = await read(async (o) => {
      if (!o.available) throw Error('Moduł etykiet jest niedostępny.');
      const r = await api<PreviewReply>('/print-jobs/label-previews/' + id);
      checkPrintJobFlags(r);
      if (!r.available || !r.can_read)
        throw new ApiError('Brak bieżącego dostępu do podglądu etykiety.', 403);
      const p = r.preview;
      checkPreview(p, props.orderId, props.shipmentId);
      if (p.id !== id || (preview?.id === id && !samePreview(preview, p)))
        throw Error('Podgląd nie odpowiada odczytywanemu zamrożonemu plikowi.');
      const contentVerified = !props.readOnly && !r.read_only;
      let pdfData: Uint8Array | null = null;
      if (contentVerified) {
        const content = await api<ContentReply>(`/print-jobs/label-previews/${id}/content`);
        checkPrintJobFlags(content);
        if (!content.available || !content.can_read)
          throw new ApiError('Brak bieżącego dostępu do pliku etykiety.', 403);
        if (
          content.preview_id !== p.id ||
          content.format !== 'pdf' ||
          content.content_sha256 !== p.content_sha256 ||
          content.content_bytes !== p.content_bytes ||
          typeof content.content_base64 !== 'string' ||
          content.content_base64.length > 2796204 ||
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
            content.content_base64,
          )
        )
          throw Error('Niepełny zamrożony plik etykiety.');
        const binary = atob(content.content_base64),
          bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
        const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
          .map((v) => v.toString(16).padStart(2, '0'))
          .join('');
        if (
          bytes.byteLength !== p.content_bytes ||
          hash !== p.content_sha256 ||
          !binary.startsWith('%PDF-')
        )
          throw Error('Bajty etykiety nie odpowiadają trwałemu podglądowi.');
        pdfData = bytes;
      }
      let job: PrintJobHead | null = null;
      if (p.queued_job_id) {
        const d = await api<PrintJobWriteReply>(`/print-jobs/jobs/${p.queued_job_id}`);
        checkPrintJobFlags(d);
        if (!d.available || !d.can_read)
          throw new ApiError('Brak dostępu do zapisanego zadania.', 403);
        job = d.job!;
        checkPrintJobHead(job);
        if (
          job.id !== p.queued_job_id ||
          job.order_id !== p.order_id ||
          job.order_snapshot.version !== p.order_snapshot.version ||
          job.printer_id !== p.printer_snapshot.id ||
          job.printer_snapshot.version !== p.printer_snapshot.version ||
          job.station_id !== p.station_snapshot.id ||
          job.station_snapshot.version !== p.station_snapshot.version ||
          job.copies !== p.copies ||
          job.format !== p.format ||
          job.content_sha256 !== p.content_sha256 ||
          job.content_bytes !== p.content_bytes ||
          job.source_kind !== 'shipment_label'
        )
          throw Error('Zapisane zadanie nie odpowiada podglądowi etykiety.');
      }
      return { preview: p, job, contentVerified, pdfData };
    });
    if (result) {
      setPreview(result.preview);
      setContentRead(result.contentVerified ? result.preview.id : null);
      setPdfReady(null);
      setPdfContent(
        result.pdfData
          ? {
              identity,
              epoch: getPrintJobsMutationState(props.contextKey).epoch,
              previewId: result.preview.id,
              sha256: result.preview.content_sha256,
              data: result.pdfData,
            }
          : null,
      );
      setJob(result.job);
    }
  }
  async function write(attempt: PrintWriteAttempt, retry = false) {
    if (busy || !writable || (retry ? ownPending !== attempt : freshBlocked)) return;
    const n = ++generation.current,
      id = identity;
    let freshCacheChecked = false;
    setError('');
    setSuccess('');
    setConsent(false);
    setCacheConsent(false);
    setAbandonConsent(false);
    setRetryConsent(false);
    try {
      await performShipmentLabelPrintWrite({
        attempt,
        retry,
        readOnly: props.readOnly,
        validate: validateReply,
        beforeSend: () => {
          if (liveProps.current.externalWriteBlocked)
            throw Error('Zapis etykiety jest zablokowany przez inną zachowaną próbę.');
        },
        access: async () => {
          if (liveProps.current.readOnly)
            throw new ApiError('Ten widok jest tylko do odczytu.', 423);
          const o = await access();
          if (['label_cache', 'label_cache_reconcile'].includes(attempt.kind)) {
            const m = await api<CacheMetadata>(
              `/print-jobs/shipments/${props.shipmentId}/label-cache`,
            );
            checkCacheMetadata(m, props.orderId, props.shipmentId);
            if (!m.available || !m.can_read || !m.can_write || m.read_only)
              throw new ApiError(
                'Brak bieżącego dostępu do pobierania etykiety.',
                m.read_only ? 423 : 403,
              );
            if (!retry && !freshCacheChecked && attempt.kind === 'label_cache') {
              const body = JSON.parse(attempt.body);
              if (
                !m.can_acquire ||
                m.source_hash !== body.source_hash ||
                m.order_version !== body.order_version
              )
                throw new ApiError(
                  'Zakres pobrania zmienił się. Odczytaj etykietę i zaznacz świeżą zgodę.',
                  409,
                );
              freshCacheChecked = true;
            }
          }
          return o;
        },
      });
    } catch (err) {
      if (
        alive.current &&
        generation.current === n &&
        scope.current === id &&
        getPrintJobsMutationState(props.contextKey).active
      ) {
        if (
          err instanceof ApiError &&
          err.status < 500 &&
          ![408, 429].includes(err.status) &&
          !getPrintJobsMutationState(props.contextKey).pending
        )
          invalidate();
        fail(err);
      }
    }
  }
  function prepare() {
    const station = options?.stations.find((s) => s.id === stationId),
      printer = printers.find((p) => p.id === printerId);
    if (
      freshBlocked ||
      !cacheMetadata ||
      (cacheMetadata.available && !cacheMetadata.can_queue) ||
      !order ||
      !station?.enabled ||
      !printer?.enabled ||
      printer.station_id !== station.id ||
      printer.format !== 'pdf' ||
      !/^(?:[1-9]|10)$/.test(copies)
    )
      return;
    invalidate();
    setJob(null);
    void write({
      context: props.contextKey,
      owner,
      kind: 'label_preview',
      path: `/print-jobs/shipments/${props.shipmentId}/label-previews`,
      body: JSON.stringify({
        client_key: crypto.randomUUID(),
        order_version: order.version,
        station_id: station.id,
        station_version: station.version,
        printer_id: printer.id,
        printer_version: printer.version,
        copies: Number(copies),
        ...(cacheMetadata.cache ? { asset_id: cacheMetadata.cache.id } : {}),
      }),
      ...(cacheMetadata.cache ? { evidence: cacheMetadata.cache } : {}),
    });
  }
  function acquireCache() {
    if (
      freshBlocked ||
      !cacheMetadata?.available ||
      !cacheMetadata.can_acquire ||
      cacheMetadata.cache ||
      !cacheConsent ||
      !cacheMetadata.source_hash ||
      !cacheMetadata.order_version
    )
      return;
    invalidate();
    void write({
      context: props.contextKey,
      owner,
      kind: 'label_cache',
      path: `/print-jobs/shipments/${props.shipmentId}/label-cache`,
      body: JSON.stringify({
        client_key: crypto.randomUUID(),
        order_version: cacheMetadata.order_version,
        source_hash: cacheMetadata.source_hash,
        confirmed_existing_label: true,
      }),
    });
  }
  function abandonCache(a: Acquisition) {
    if (freshBlocked || !a.can_reconcile || abandonId !== a.id || !abandonConsent) return;
    invalidate();
    void write({
      context: props.contextKey,
      owner,
      kind: 'label_cache_reconcile',
      path: `/print-jobs/label-cache/acquisitions/${a.id}/reconcile`,
      body: JSON.stringify({ client_key: crypto.randomUUID(), confirmed_abandon: true }),
      evidence: a,
    });
  }
  function queue() {
    if (
      freshBlocked ||
      !preview ||
      !preview.can_queue ||
      preview.queued_job_id ||
      contentRead !== preview.id ||
      !renderedPdf ||
      !consent ||
      Date.parse(preview.expires_at) <= Date.now()
    )
      return;
    void write({
      context: props.contextKey,
      owner,
      kind: 'label_queue',
      path: `/print-jobs/label-previews/${preview.id}/queue`,
      body: JSON.stringify({
        client_key: crypto.randomUUID(),
        scope_hash: preview.scope_hash,
        confirmed: true,
      }),
      evidence: preview,
    });
  }
  useEffect(() => {
    alive.current = true;
    resetPrintJobsContext(props.contextKey);
    const off = subscribePrintJobsLock(props.contextKey, () => redraw((v) => v + 1));
    return () => {
      alive.current = false;
      generation.current++;
      off();
    };
  }, [props.contextKey]);
  useEffect(() => {
    generation.current++;
    purge();
    setLoaded('');
    setLoadedEpoch(-1);
    setReading(false);
    setError('');
    setSuccess('');
    seenOutcome.current = null;
    void load();
  }, [identity]);
  useEffect(() => {
    if (loadedEpoch !== io.epoch && loadedEpoch !== -1) purge();
    const result = io.outcome;
    if (
      !visible ||
      !result ||
      !result.attempt ||
      result.attempt.owner !== owner ||
      !['label_preview', 'label_queue', 'label_cache', 'label_cache_reconcile'].includes(
        result.kind,
      ) ||
      seenOutcome.current === result.reply
    )
      return;
    seenOutcome.current = result.reply;
    if (result.kind === 'label_preview') {
      const p = result.reply.preview as Preview;
      try {
        checkPreview(p, props.orderId, props.shipmentId);
        setPreview(p);
        setContentRead(null);
        setPdfContent(null);
        setPdfReady(null);
        setJob(null);
        setConsent(false);
        setSuccess('Podgląd zapisany. Odczytaj cały plik przed zgodą na kolejkę.');
      } catch (err) {
        fail(err);
      }
    } else if (result.kind === 'label_queue') {
      const p = result.attempt.evidence as Preview;
      try {
        checkPreview(p, props.orderId, props.shipmentId);
        checkPrintJobHead(result.reply.job!);
        setPreview({ ...p, queued_job_id: result.reply.job!.id, can_queue: false });
        setJob(result.reply.job!);
        setConsent(false);
        setSuccess('Zadanie etykiety zapisane w kolejce. Nie oznacza to wydruku na papierze.');
      } catch (err) {
        fail(err);
      }
    } else {
      try {
        const r = result.reply as CacheReply;
        checkCacheReply(r, props.orderId, props.shipmentId);
        invalidate();
        setJob(null);
        setCacheConsent(false);
        setAbandonConsent(false);
        setAbandonId('');
        setCacheDetail(r);
        setCacheMetadata((m) =>
          m
            ? {
                ...m,
                cache: r.cache,
                latest_acquisition: r.acquisition,
                can_acquire: false,
                can_queue: false,
              }
            : null,
        );
        setSuccess(
          result.kind === 'label_cache_reconcile'
            ? 'Próba pobrania zamknięta bez kolejnego żądania do przewoźnika. Odczytaj bieżącą dostępność.'
            : r.acquisition.state === 'ready'
              ? 'Etykieta zapisana. Odczytaj dostępność, a następnie przygotuj podgląd PDF i osobną zgodę na kolejkę.'
              : 'Zapisano stan próby pobrania. Sprawdź wynik i historię; etykieta nie została skierowana do drukowania.',
        );
      } catch (err) {
        fail(err);
      }
    }
  }, [visible, loadedEpoch, io.epoch, io.outcome, owner]);
  useEffect(() => {
    if (!preview) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [preview?.id]);
  const expired = !!preview && Date.parse(preview.expires_at) <= now;
  function cacheHeadView(c: LabelCache) {
    return (
      <div className="slp-cache-head">
        <p>
          {c.provider === 'inpost' ? 'InPost' : 'DPD'} · {c.mode} · przesyłka {c.tracking_number} ·
          PDF {c.layout}
        </p>
        <p>
          {c.origin === 'provider_get'
            ? 'Plik z jawnego pobrania istniejącej etykiety'
            : 'Wcześniej zapisany plik DPD'}{' '}
          · {c.content_bytes} bajtów · zapisano {date(c.created_at)}
        </p>
        <details>
          <summary>Tożsamość zapisanego pliku</summary>
          <p>SHA-256 {c.content_sha256}</p>
          <p>
            Plik {c.id} · próba {c.acquisition_id}
          </p>
        </details>
      </div>
    );
  }
  function acquisitionView(a: Acquisition) {
    const errors: Record<string, string> = {
      LABEL_FETCH_FAILED: 'Nie udało się pobrać etykiety.',
      LABEL_INVALID: 'Plik etykiety nie spełnia wymagań bezpieczeństwa lub formatu.',
      SOURCE_CHANGED: 'Dane przesyłki zmieniły się.',
      ACCESS_REVOKED: 'Dostęp do pobierania został wycofany.',
      ABANDONED: 'Próba została świadomie zamknięta.',
    };
    return (
      <article key={a.id}>
        <h4>{acquisitionNames[a.state]}</h4>
        <p>
          Rozpoczęto {date(a.created_at)} · ostatni odczyt stanu {date(a.updated_at)}
        </p>
        {a.error_code && <p>{errors[a.error_code] ?? 'Próba wymaga wyjaśnienia.'}</p>}
        {a.asset_id && (
          <button
            className="button"
            disabled={busy}
            onClick={() => void loadCacheDetail(a.asset_id!)}
          >
            Odczytaj zapis etykiety
          </button>
        )}
        {['fetching', 'unknown'].includes(a.state) && (
          <p>
            Nie potwierdzono pliku. Odczyt ani zamknięcie próby nie ponawiają pobrania u
            przewoźnika.
          </p>
        )}
        {a.can_reconcile && (
          <div className="slp-warning">
            <p>
              Zamknięcie pozostawi tę próbę w historii. Nie potwierdzi, czy wcześniejsze pobranie
              zostało wykonane, i nie utworzy pliku ani zadania.
            </p>
            <label className="slp-check">
              <input
                type="checkbox"
                disabled={freshBlocked}
                checked={abandonId === a.id && abandonConsent}
                onChange={(e) => {
                  setAbandonId(a.id);
                  setAbandonConsent(e.target.checked);
                }}
              />
              Chcę zamknąć tę nierozstrzygniętą próbę bez ponownego pobrania
            </label>
            <button
              className="button"
              disabled={freshBlocked || abandonId !== a.id || !abandonConsent}
              onClick={() => abandonCache(a)}
            >
              Zamknij próbę bez pobrania
            </button>
          </div>
        )}
      </article>
    );
  }
  return (
    <section
      className="panel shipment-label-print"
      aria-label="Etykieta przesyłki do kolejki wydruku"
    >
      <div className="slp-heading">
        <h2>Etykieta przesyłki do kolejki wydruku</h2>
        <button className="button" onClick={props.onClose}>
          Zamknij podgląd
        </button>
      </div>
      <p>
        Przygotowanie i kolejka nie nadają nowej przesyłki ani nie wydają towaru z magazynu. Zapis
        pliku lub przekazanie do CUPS nie potwierdza papierowego wydruku.
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {success && <p role="status">{success}</p>}
      <button className="button" disabled={busy} onClick={() => void load()}>
        Odczytaj dostęp, zamówienie i drukarki
      </button>
      {visible && !options?.available && (
        <p>Ta kopia nie zawiera podglądu etykiet dla kolejki wydruku.</p>
      )}
      {(props.readOnly || options?.read_only) && (
        <p>
          Widok tylko do odczytu. Przygotowanie nowego podglądu i zapis do kolejki są zablokowane.
        </p>
      )}
      {io.locked && (
        <div className="slp-warning">
          <p>
            {io.inFlight
              ? 'Trwa zapis drukowania. Pozostałe nowe zadania są zablokowane.'
              : 'Wynik zapisu jest nierozstrzygnięty. Zachowano dokładną treść i klucz; odczyt nie usuwa próby.'}
          </p>
          {ownPending ? (
            <>
              <label className="slp-check">
                <input
                  type="checkbox"
                  checked={retryConsent}
                  disabled={busy || !writable}
                  onChange={(e) => setRetryConsent(e.target.checked)}
                />
                Chcę ponowić dokładnie zachowaną próbę tej przesyłki
              </label>
              <button
                className="button"
                disabled={busy || !writable || !retryConsent}
                onClick={() => void write(ownPending, true)}
              >
                Ponów tę samą próbę
              </button>
            </>
          ) : (
            <p>
              Wróć do panelu, w którym rozpoczęto zapis. Nowe zadania z ręcznych plików i innych
              etykiet pozostają zablokowane.
            </p>
          )}
        </div>
      )}
      {visible && options?.available && (
        <>
          <article className="slp-cache-section">
            <h3>Plik istniejącej etykiety</h3>
            <p>
              Pobranie zapisuje istniejącą etykietę. Nie kupuje nowej przesyłki, nie nadaje paczki i
              nie uruchamia drukowania.
            </p>
            {!cacheMetadata && <p>Odczytaj dostępność etykiety przed nowym podglądem.</p>}
            {cacheMetadata && !cacheMetadata.available && (
              <p>
                Ta kopia nie zawiera cache etykiet. Dotychczasowy podgląd DEMO lub zapisanego PDF
                DPD pozostaje osobnym procesem.
              </p>
            )}
            {cacheMetadata?.available && (
              <>
                {cacheMetadata.cache ? (
                  cacheHeadView(cacheMetadata.cache)
                ) : (
                  <p>Nie ma zapisanego pliku etykiety dla tej przesyłki.</p>
                )}
                {cacheMetadata.unavailable_reason && (
                  <p className="slp-warning">{cacheMetadata.unavailable_reason}</p>
                )}
                {cacheMetadata.can_acquire && !cacheMetadata.cache && (
                  <>
                    <label className="slp-check">
                      <input
                        type="checkbox"
                        disabled={freshBlocked}
                        checked={cacheConsent}
                        onChange={(e) => setCacheConsent(e.target.checked)}
                      />
                      Potwierdzam pobranie istniejącej etykiety tej przesyłki do cache, bez nowego
                      nadania i bez drukowania
                    </label>
                    <button
                      className="button"
                      disabled={freshBlocked || !cacheConsent}
                      onClick={acquireCache}
                    >
                      Pobierz istniejącą etykietę do cache
                    </button>
                  </>
                )}
                {cacheMetadata.latest_acquisition &&
                  acquisitionView(cacheMetadata.latest_acquisition)}
                <button
                  className="button"
                  disabled={busy}
                  onClick={() => void loadCacheHistory(false)}
                >
                  Odczytaj historię pobrań
                </button>
                {cacheHistoryRead && (
                  <div className="slp-cache-history">
                    <p>
                      Odczytano {cacheHistory.length} prób
                      {cacheCursor ? ' · dostępna kolejna strona' : ' · pełny odczyt historii'}
                    </p>
                    {cacheHistory.map((a) => acquisitionView(a))}
                    {cacheCursor && (
                      <button
                        className="button"
                        disabled={busy}
                        onClick={() => void loadCacheHistory(true)}
                      >
                        Odczytaj następną stronę historii
                      </button>
                    )}
                  </div>
                )}
              </>
            )}
            {cacheDetail?.cache && (
              <section
                className="slp-cache-detail"
                aria-label="Szczegóły zapisanego pliku etykiety"
              >
                <h4>Odczytany zapis etykiety</h4>
                {cacheHeadView(cacheDetail.cache)}
                <p>
                  To odczyt historii. Bieżącą etykietę wybiera aktualna dostępność przesyłki;
                  obejrzenie PDF i zgoda na kolejkę następują w osobnym podglądzie poniżej.
                </p>
              </section>
            )}
            <button className="button" disabled={busy} onClick={() => void load()}>
              Odczytaj dostępność etykiety
            </button>
          </article>
          <fieldset disabled={freshBlocked}>
            <legend>Konfiguracja zadania</legend>
            <p>
              Zamówienie {order?.number ?? '—'} · wersja {order?.version ?? '—'}
            </p>
            <div className="slp-grid">
              <label>
                Stanowisko pakowania
                <select
                  value={stationId}
                  onChange={(e) => {
                    setStationId(e.target.value);
                    setPrinterId('');
                    invalidate();
                  }}
                >
                  <option value="">Wybierz aktywne stanowisko</option>
                  {options.stations
                    .filter((s) => s.enabled)
                    .map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.code} · {s.label}
                      </option>
                    ))}
                </select>
              </label>
              <label>
                Drukarka PDF
                <select
                  value={printerId}
                  onChange={(e) => {
                    setPrinterId(e.target.value);
                    invalidate();
                  }}
                >
                  <option value="">Wybierz aktywną drukarkę PDF</option>
                  {printers
                    .filter((p) => p.enabled && p.station_id === stationId && p.format === 'pdf')
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} · {p.output_mode === 'file' ? 'plik lokalny' : 'CUPS'}
                      </option>
                    ))}
                </select>
              </label>
              <label>
                Liczba kopii
                <input
                  type="number"
                  min={1}
                  max={10}
                  step={1}
                  value={copies}
                  onChange={(e) => {
                    setCopies(e.target.value);
                    invalidate();
                  }}
                />
              </label>
            </div>
            <p>
              Podgląd korzysta z zapisanego PDF InPost/DPD albo lokalnego PDF DEMO. Nie pobiera
              etykiety od przewoźnika. Drukarki ZPL nie przyjmują tego PDF.
            </p>
            <p>
              Nowy podgląd i kolejna zgoda mogą utworzyć dodatkową kopię tej samej etykiety. Sprawdź
              historię zadań przed ponownym drukiem.
            </p>
            <button
              className="button"
              disabled={
                !order ||
                !cacheMetadata ||
                (cacheMetadata.available && !cacheMetadata.can_queue) ||
                !stationId ||
                !printerId ||
                !/^(?:[1-9]|10)$/.test(copies)
              }
              onClick={prepare}
            >
              Przygotuj podgląd etykiety i zadania
            </button>
          </fieldset>
          {preview && (
            <article>
              <h3>Trwały podgląd etykiety</h3>
              <p>
                {sourceNames[preview.source_kind]} · {preview.source_snapshot.carrier} ·{' '}
                {preview.source_snapshot.mode} · {preview.source_snapshot.tracking_number}
              </p>
              <p>
                Zamówienie {preview.order_snapshot.number} · wersja {preview.order_snapshot.version}{' '}
                · {preview.station_snapshot.label} · {preview.printer_snapshot.name} ·{' '}
                {preview.copies} kopii
              </p>
              <p>
                {preview.content_bytes} bajtów · SHA-256 {preview.content_sha256}
              </p>
              <p>
                {preview.printer_snapshot.output_mode === 'file'
                  ? 'Wyjście: plik lokalny. Nie oznacza wydruku na papierze.'
                  : `Wyjście: kolejka CUPS ${preview.printer_snapshot.cups_queue}. Przyjęcie przez CUPS nie potwierdza papieru.`}
              </p>
              <button
                className="button"
                disabled={busy}
                onClick={() => void loadPreview(preview.id)}
              >
                Odczytaj pełny plik i aktualny wynik podglądu
              </button>
              {contentRead === preview.id && (
                <div className="slp-pdf-section">
                  {pdfContent &&
                    pdfContent.identity === identity &&
                    pdfContent.epoch === io.epoch &&
                    pdfContent.previewId === preview.id &&
                    pdfContent.sha256 === preview.content_sha256 && (
                      <PrintLabelPdfPreview
                        key={
                          identity +
                          ':' +
                          io.epoch +
                          ':' +
                          preview.id +
                          ':' +
                          preview.content_sha256
                        }
                        contextKey={identity + ':' + io.epoch}
                        previewId={preview.id}
                        contentSha256={preview.content_sha256}
                        data={pdfContent.data}
                        onReady={(result) => {
                          if (
                            !alive.current ||
                            scope.current !== pdfContent.identity ||
                            getPrintJobsMutationState(props.contextKey).epoch !==
                              pdfContent.epoch ||
                            result.previewId !== preview.id ||
                            result.contentSha256 !== preview.content_sha256
                          )
                            return;
                          if (result.ready)
                            setPdfReady({
                              identity,
                              epoch: pdfContent.epoch,
                              previewId: result.previewId,
                              sha256: result.contentSha256,
                            });
                          else {
                            setPdfReady(null);
                            setConsent(false);
                          }
                        }}
                      />
                    )}
                  <a
                    className="button"
                    href={`/api/print-jobs/label-previews/${preview.id}/pdf?workspace_id=${encodeURIComponent(props.contextKey.split(':')[0])}`}
                  >
                    Pobierz sprawdzony PDF
                  </a>
                  <p>
                    Sprawdź wszystkie strony widoczne powyżej. Pobranie pliku nie zastępuje podglądu
                    ani nie uruchamia drukowania.
                  </p>
                </div>
              )}
              {(props.readOnly || options.read_only) && (
                <p>
                  W podglądzie kopii można odczytać metadane; pobieranie pliku PDF jest zablokowane.
                </p>
              )}
              <p>
                Ważny do {date(preview.expires_at)}.
                {expired && ' Podgląd wygasł. Przygotuj nowy przed zapisem.'}
              </p>
              {!preview.queued_job_id && (
                <>
                  <label className="slp-check">
                    <input
                      type="checkbox"
                      checked={consent}
                      disabled={
                        freshBlocked ||
                        expired ||
                        !preview.can_queue ||
                        contentRead !== preview.id ||
                        !renderedPdf
                      }
                      onChange={(e) => setConsent(e.target.checked)}
                    />
                    Sprawdziłem cały PDF, pochodzenie etykiety, zamówienie, drukarkę i kopie. Zapisz
                    zadanie w kolejce.
                  </label>
                  <button
                    className="button primary"
                    disabled={
                      freshBlocked ||
                      expired ||
                      !preview.can_queue ||
                      contentRead !== preview.id ||
                      !renderedPdf ||
                      !consent
                    }
                    onClick={queue}
                  >
                    Zapisz etykietę w kolejce
                  </button>
                </>
              )}
              {preview.queued_job_id && (
                <p>
                  Ten podgląd ma już zapisane zadanie. Odczyt wyniku nie tworzy kolejnego wydruku.
                </p>
              )}
            </article>
          )}
          {job && (
            <article>
              <h3>Zapisane zadanie etykiety</h3>
              <p>
                {stateNames[job.state] ?? job.state} · {job.order_number} ·{' '}
                {job.printer_snapshot.name} · {job.copies} kopii
              </p>
              <p>
                {job.content_bytes} bajtów · SHA-256 {job.content_sha256}
              </p>
              {job.state === 'file_saved' && (
                <p>Zapisano plik lokalnie; nie potwierdzono wydruku na papierze.</p>
              )}
              {job.state === 'spool_submitted' && (
                <p>CUPS przyjął zadanie; nie potwierdzono wydruku na papierze.</p>
              )}
              {job.state === 'unknown' && (
                <p>
                  Zadanie mogło zostać wydrukowane. Uzgodnij wynik z operatorem przed osobnym
                  ponownym wydrukiem.
                </p>
              )}
              <p>
                Historię i zdarzenia zadania odczytasz w trwałej kolejce drukowania na tej karcie
                zamówienia.
              </p>
            </article>
          )}
        </>
      )}
    </section>
  );
}
