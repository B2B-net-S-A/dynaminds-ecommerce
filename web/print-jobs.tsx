import { PackedLabelPrintPanel } from './packed-label-print';
import { useEffect, useRef, useState } from 'react';
import { api, ApiError, date } from './api';
import './print-jobs.css';
import { browserRecovery, recoveryActor, recoveryRef, confirmedRecovery, matchesRecovery, originalKeyLocation, confirmOriginalKey, type RecoveryRef } from './browser-recovery-custody';

export type PrintWriteAttempt = { context: string; kind: 'printer' | 'job' | 'reconcile' | 'label_preview' | 'label_queue' | 'label_cache' | 'label_cache_reconcile' | 'batch_preview' | 'batch_queue' | 'packed_preview' | 'packed_approve' | 'packed_resolve'; path: string; body: string;
  owner?: string;
  evidence?: unknown; recoveryOnly?: boolean; };
type Attempt = PrintWriteAttempt;
type FileReview = { name: string; format: 'pdf' | 'zpl'; bytes: number; sha256: string; base64: string; text: string | null; data: Uint8Array; };
let actorContext = '';
let epoch = 0;
let pending: Attempt | null = null;
let inFlight = false;
let recovery: RecoveryRef | null = null;
let recoveryError = '';
function restoreRecovery(context: string) {
  recovery = null; recoveryError = '';
  if (!context) return;
  try {
    recovery = browserRecovery.get(recoveryActor(context), 'print');
    if (recovery) pending = { context, kind: 'job', path: recovery.path, body: '{}', recoveryOnly: true };
  } catch (error) { recoveryError = error instanceof Error ? error.message : 'Nie można odczytać zachowanej próby.'; }
}
function persistPrintAttempt(a: Attempt) {
  if (a.recoveryOnly || recoveryError) throw Error('Najpierw odczytaj oryginalny wynik.');
  const previous = browserRecovery.get(recoveryActor(a.context), 'print');
  if (previous && !pending && outcome?.context === a.context && outcome.attempt && previous.path === outcome.attempt.path && previous.key === recoveryRef(a.context,'print',outcome.attempt.path,outcome.attempt.body).key) browserRecovery.clear(previous);
  const r = recoveryRef(a.context, 'print', a.path, a.body);
  try { browserRecovery.put(r); recovery = r; }
  catch (err) { recoveryError = err instanceof Error ? err.message : 'Nie zapisano oryginalnej próby.'; throw err; }
}
function acknowledgePrint(a: Attempt, reply: WriteReply) {
  const r = browserRecovery.get(recoveryActor(a.context), 'print');
  if (!r || r.path !== a.path) throw Error('Brak zachowanej oryginalnej próby.');
  const resource = reply.job ?? reply.printer;
  if (resource) {
    const known = confirmedRecovery(r, resource.id, resource.version, reply.job?.order_id ?? null, reply.event?.id ?? null, reply.job?.content_sha256 ?? null);
    browserRecovery.put(known); if (actorContext === a.context) recovery = known;
  }
}
function forgetPrintRefusal(a: Attempt) {
  const r = browserRecovery.get(recoveryActor(a.context), 'print');
  if (r && r.path === a.path) browserRecovery.clear(r);
  recovery = null;
}
let outcome: { context: string; kind: Attempt['kind']; reply: WriteReply;
  attempt?: Attempt; } | null = null;
const listeners = new Set<() => void>();
const publish = () => listeners.forEach((fn) => fn());
export function resetPrintJobsContext(contextKey: string) {
  if (actorContext === contextKey) return;
  actorContext = contextKey;
  epoch++;
  pending = null;
  inFlight = false;
  outcome = null;
  restoreRecovery(contextKey);
  publish();
}
export function subscribePrintJobsLock(contextKey: string, callback: (locked: boolean) => void) {
  const notify = () => callback(actorContext === contextKey && Boolean(pending || inFlight || recoveryError));
  listeners.add(notify);
  notify();
  return () => { listeners.delete(notify); };
}
export function getPrintJobsMutationState(contextKey: string) {
  return {
    active: actorContext === contextKey,
    epoch,
    locked: actorContext === contextKey && Boolean(pending || inFlight || recoveryError),
    inFlight: actorContext === contextKey && inFlight,
    recoveryError: actorContext === contextKey ? recoveryError : '',
    pending: actorContext === contextKey ? pending : null,
    outcome: actorContext === contextKey ? outcome : null,
  };
}
export function purgePrintJobsAccess(contextKey: string) {
  if (actorContext !== contextKey) return;
  epoch++;
  pending = null;
  inFlight = false;
  outcome = null;
  restoreRecovery(contextKey);
  publish();
}
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
async function readFile(file: File, format: 'pdf' | 'zpl'): Promise<FileReview> {
  if (file.size < 1 || file.size > 2097152) throw Error('Wybierz niepusty plik do 2 MiB.');
  const data = new Uint8Array(await file.arrayBuffer());
  if (data.byteLength !== file.size) throw Error('Nie udało się odczytać całego pliku.');
  let text: string | null = null;
  if (format === 'zpl') text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data);
  else if (String.fromCharCode(...data.slice(0, 5)) !== '%PDF-') throw Error('Plik nie ma nagłówka PDF.');
  const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))].map((n) => n.toString(16).padStart(2, '0')).join('');
  let binary = '';
  for (let i = 0; i < data.length; i += 8192) binary += String.fromCharCode(...data.subarray(i, i + 8192));
  return { name: file.name, format, bytes: data.byteLength, sha256, base64: btoa(binary), text, data, };
}

type Flags = { available: boolean; read_only: boolean; current_role: string | null; can_read: boolean; can_write: boolean; can_manage: boolean; };
type Station = { id: string; version: string; code: string; label: string; enabled: boolean };
type Printer = { id: string; version: string; station_id: string; name: string; format: 'pdf' | 'zpl'; output_mode: 'file' | 'cups'; cups_queue: string | null; enabled: boolean; };
type Options = Flags & { stations: Station[]; limits: Record<string, number> };
type WavePrintSnapshot={wave:{id:string;tenant_id:string;name:string;warehouse_id:string;state:string;version:string};orders:{id:string;number:string;version:string;status:string;payment_mode:string;slot:number;active:boolean}[];lines:{order_id:string;product_id:string;location:string;quantity:number;scanned:number;reservation_state:string;order_sku:string;order_ean:string;pick_quantity:number;pick_scanned:number;sku:string;ean:string|null;name:string}[]};
type OrderJobSource={source_kind?:'manual'|'shipment_label';order_id:string;order_number:string;order_snapshot:{id:string;version:string};wave_id?:never;wave_snapshot?:never};
type WaveJobSource={source_kind:'picking_wave';order_id:null;order_number:null;order_snapshot:null;wave_id:string;wave_snapshot:WavePrintSnapshot};
type Job = (OrderJobSource|WaveJobSource) & { id: string; version: string; station_id: string; station_snapshot: Station; printer_id: string; printer_snapshot: Printer;
  format: 'pdf' | 'zpl'; copies: number; content_sha256: string; content_bytes: number; state: string; lease_expires_at: string | null; retry_of_job_id: string | null; created_at: string; updated_at: string; can_claim: boolean; can_reconcile: boolean; };
type Event = { id: string; operation: string; version_before: string | null; version_after: string; created_at: string; result: { receipt?: { result?: string; artifact_name?: string; spool_job_id?: string; error_code?: string; note?: string; }; }; };
type WriteReply = Flags & { printer?: Printer; job?: Job; event?: Event; events?: Event[];
  preview?: unknown;
  execution?: unknown;
  preview_id?: string; reused?: boolean; };
export type PrintJobFlags = Flags;
export type PrintJobOptions = Options;
export type PrintJobPrinter = Printer;
export type PrintJobStation = Station;
export type PrintJobHead = Job;
export type PrintJobWriteReply = WriteReply;
type Detail = Flags & { job: Job; events: Event[] };
type Review = { file: FileReview; order: { id: string; number: string; version: string }; station: Station; printer: Printer; copies: number; retryOf: Job | null; };
const validVersion = (v: unknown): v is string => typeof v === 'string' && /^[1-9][0-9]{0,18}$/.test(v) && BigInt(v) <= 9223372036854775807n;
function checkFlags(v: Flags) {
  if (!v || ['available', 'read_only', 'can_read', 'can_write', 'can_manage'].some((k) => typeof v[k as keyof Flags] !== 'boolean',) || (v.current_role !== null && !['admin', 'operator', 'viewer'].includes(v.current_role))) throw Error('Niepełny odczyt dostępu do drukowania.');
}
function checkPrinter(p: Printer) {
  if (!p || !uuid(p.id) || !uuid(p.station_id) || !validVersion(p.version) || !p.name || !['pdf', 'zpl'].includes(p.format) || !['file', 'cups'].includes(p.output_mode) || typeof p.enabled !== 'boolean' || (p.output_mode === 'cups' && !p.cups_queue)) throw Error('Niepełna konfiguracja drukarki.');
}
function checkWaveJobSource(j:WaveJobSource&{format:string;retry_of_job_id:string|null}){
 const b=j.wave_snapshot,w=b?.wave;
 if(j.order_id!==null||j.order_number!==null||j.order_snapshot!==null||!uuid(j.wave_id)||w?.id!==j.wave_id||!uuid(w.tenant_id)||!uuid(w.warehouse_id)||!w.name||!validVersion(w.version)||!['picking','completed','cancelled'].includes(w.state)||j.format!=='pdf'||j.retry_of_job_id!==null||!Array.isArray(b.orders)||b.orders.length<1||b.orders.length>100||new Set(b.orders.map(o=>o.id)).size!==b.orders.length||b.orders.some(o=>!uuid(o.id)||!o.number||!validVersion(o.version)||!o.status||!o.payment_mode||!Number.isSafeInteger(o.slot)||o.slot<1||o.slot>100||typeof o.active!=='boolean')||!Array.isArray(b.lines)||b.lines.length>2000||b.lines.some(l=>!b.orders.some(o=>o.id===l.order_id)||!uuid(l.product_id)||typeof l.location!=='string'||!Number.isSafeInteger(l.quantity)||l.quantity<1||l.quantity>2147483647||!Number.isSafeInteger(l.scanned)||l.scanned<0||l.scanned>l.quantity||!l.reservation_state||typeof l.sku!=='string'||typeof l.order_sku!=='string'||typeof l.name!=='string'||typeof l.order_ean!=='string'||(l.ean!==null&&typeof l.ean!=='string')||!Number.isSafeInteger(l.pick_quantity)||l.pick_quantity<1||l.pick_quantity>2147483647||!Number.isSafeInteger(l.pick_scanned)||l.pick_scanned<0||l.pick_scanned>l.pick_quantity))throw Error('Niepełne pochodzenie listy całej partii.');
}
function printJobSourceName(j:Job){return j.source_kind==='picking_wave'?'Partia '+j.wave_snapshot.wave.name+' · v'+j.wave_snapshot.wave.version:j.order_number;}
function checkJob(j: Job) {
  if (!j || !uuid(j.id) || (j.source_kind!=='picking_wave'&&!uuid(j.order_id)) || !uuid(j.station_id) || !uuid(j.printer_id) || !validVersion(j.version) || !/^[a-f0-9]{64}$/.test(j.content_sha256) || !Number.isSafeInteger(j.content_bytes) || j.content_bytes < 1 || j.content_bytes > 2097152 || !Number.isInteger(j.copies) || j.copies < 1 || j.copies > 10 || !['pdf', 'zpl'].includes(j.format) || !Object.hasOwn(stateNames, j.state) || typeof j.can_reconcile !== 'boolean') throw Error('Niepełny trwały wynik zadania drukowania.');
  if(j.source_kind==='picking_wave')checkWaveJobSource(j);
  checkPrinter(j.printer_snapshot);
  if (j.printer_snapshot.id !== j.printer_id || j.printer_snapshot.station_id !== j.station_id || j.printer_snapshot.format !== j.format || j.station_snapshot?.id !== j.station_id || !validVersion(j.station_snapshot.version) || (j.source_kind!=='picking_wave'&&(j.order_snapshot?.id !== j.order_id || !validVersion(j.order_snapshot.version)))) throw Error('Konfiguracja drukarki, stanowiska lub zamówienia nie odpowiada zadaniu.');
}
function checkEvents(events: Event[]) {
  if (!Array.isArray(events) || events.length > 10000 || new Set(events.map((e) => e.id)).size !== events.length || events.some((e) => !uuid(e.id) || !Object.hasOwn(operationNames, e.operation) || !validVersion(e.version_after) || (e.version_before !== null && !validVersion(e.version_before)) || !Number.isFinite(Date.parse(e.created_at)),)) throw Error('Niepełny trwały zakres zdarzeń zadania.');
}
export {
  checkFlags as checkPrintJobFlags,
  checkPrinter as checkPrintJobPrinter,
  checkJob as checkPrintJobHead,
  validVersion as validPrintVersion,
};
export async function verifyPrintJobsActor(contextKey: string) {
  const r = await api<{ user: { tenant_id: string; id: string; role: string } }>('/auth/me');
  const parts = contextKey.split(':');
  if (
    parts.length !== 4 ||
    !uuid(parts[0]) ||
    !uuid(parts[1]) ||
    !['true', 'false'].includes(parts[3]) ||
    !r.user ||
    `${r.user.tenant_id}:${r.user.id}:${r.user.role}` !== parts.slice(0, 3).join(':')
  )
    throw new ApiError('Kontekst drukowania zmienił się. Otwórz panel ponownie.', 403);
}
export async function performShipmentLabelPrintWrite(args: {
  attempt: PrintWriteAttempt;
  retry: boolean;
  readOnly: boolean;
  access: () => Promise<PrintJobFlags>;
  validate: (reply: PrintJobWriteReply, attempt: PrintWriteAttempt) => Promise<void> | void;
  beforeSend?: () => void;
}): Promise<PrintJobWriteReply | null> {
  const a = args.attempt;
  if (
    actorContext !== a.context ||
    a.recoveryOnly || recoveryError ||
    inFlight ||
    args.readOnly ||
    (args.retry ? pending !== a : Boolean(pending))
  )
    return null;
  if (
    !['label_preview', 'label_queue', 'label_cache', 'label_cache_reconcile', 'batch_preview', 'batch_queue', 'packed_preview', 'packed_approve', 'packed_resolve'].includes(a.kind) ||
    !a.owner ||
    !(a.kind === 'packed_preview' ? a.path === '/print-jobs/packed-labels/previews' : a.kind === 'packed_approve' ? /^\/print-jobs\/packed-labels\/previews\/[0-9a-f-]+\/approve$/.test(a.path) : a.kind === 'packed_resolve' ? /^\/print-jobs\/packed-labels\/intentions\/[0-9a-f-]+\/resolve$/.test(a.path) : a.kind === 'batch_preview' ? a.path === '/print-jobs/label-batches/previews' : a.kind === 'batch_queue' ? /^\/print-jobs\/label-batches\/previews\/[0-9a-f-]+\/queue$/.test(a.path) : /^\/print-jobs\/(?:shipments\/[0-9a-f-]+\/(?:label-previews|label-cache)|label-previews\/[0-9a-f-]+\/queue|label-cache\/acquisitions\/[0-9a-f-]+\/reconcile)$/.test(a.path)) ||
    (a.kind !== 'packed_resolve' && !uuid(JSON.parse(a.body).client_key))
  )
    throw Error('Nieprawidłowy zachowany zakres etykiety.');
  const e = epoch;
  inFlight = true;
  publish();
  let sent = false;
  try {
    const flags = await args.access();
    if (actorContext !== a.context || epoch !== e) return null;
    checkFlags(flags);
    if (!flags.available || !flags.can_write || flags.read_only || args.readOnly)
      throw new ApiError(
        'Brak aktualnego dostępu do kolejki etykiet.',
        flags.read_only || args.readOnly ? 423 : 403,
      );
    args.beforeSend?.();
    persistPrintAttempt(a);
    pending = a;
    sent = true;
    publish();
    const reply = await api<PrintJobWriteReply>(a.path, 'POST', JSON.parse(a.body));
    if (actorContext !== a.context || epoch !== e) return null;
    checkFlags(reply);
    await args.validate(reply, a);
    acknowledgePrint(a, reply);
    const last = await args.access();
    if (actorContext !== a.context || epoch !== e) return null;
    checkFlags(last);
    if (!last.available || !last.can_read)
      throw new ApiError('Dostęp do zapisanego wyniku etykiety zmienił się.', 403);
    outcome = { context: a.context, kind: a.kind, reply, attempt: a };
    pending = null;
    publish();
    return reply;
  } catch (err) {
    if (actorContext !== a.context || epoch !== e) return null;
    if (err instanceof ApiError && [401, 403].includes(err.status)) purgePrintJobsAccess(a.context);
    else if (
      sent &&
      err instanceof ApiError &&
      err.status < 500 &&
      ![408, 429].includes(err.status)
    ) {
      forgetPrintRefusal(a);
      pending = null;
      if (outcome?.attempt?.owner === a.owner) outcome = null;
      publish();
    }
    throw err;
  } finally {
    if (actorContext === a.context && epoch === e) {
      inFlight = false;
      publish();
    }
  }
}
async function contentHash(base64: string) {
  const data = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))].map((n) => n.toString(16).padStart(2, '0')).join('');
}
async function checkWrite(reply: WriteReply, attempt: Attempt) {
  checkFlags(reply);
  const b = JSON.parse(attempt.body);
  if (attempt.kind === 'printer') {
    checkPrinter(reply.printer!);
    const p = reply.printer!;
    if (p.station_id !== b.station_id || p.name !== b.name || p.format !== b.format || p.output_mode !== b.output_mode || p.cups_queue !== b.cups_queue || p.enabled !== b.enabled) throw Error('Zapis drukarki nie odpowiada zachowanej próbie.');
  } else {
    checkJob(reply.job!);
    const j = reply.job!;
    if (attempt.kind === 'job') {
      if (j.source_kind==='picking_wave' || j.order_id !== b.order_id || j.order_snapshot.version !== b.order_version || j.printer_id !== b.printer_id || j.printer_snapshot.version !== b.printer_version || j.station_id !== b.station_id || j.station_snapshot.version !== b.station_version || j.format !== b.format || j.copies !== b.copies || j.content_bytes !== atob(b.content_base64).length || j.content_sha256 !== ( await contentHash(b.content_base64)) || (j.retry_of_job_id ?? null) !== (b.retry_of_job_id ?? null)) throw Error('Zadanie nie odpowiada dokładnej zachowanej próbie.');
    } else if (attempt.path !== `/print-jobs/jobs/${j.id}/reconcile` || j.state !== b.result) throw Error('Rozstrzygnięcie nie odpowiada zadaniu.');
  }
}
const stateNames: Record<string, string> = { queued: 'W kolejce', claimed: 'Przejęte przez wykonawcę', file_saved: 'Plik zapisany lokalnie', spool_submitted: 'Przekazane do CUPS', failed: 'Błąd', unknown: 'Wynik nieznany', cancelled: 'Anulowane', };
const operationNames: Record<string, string> = { printer_create: 'Drukarka zarejestrowana', printer_update: 'Konfiguracja drukarki zmieniona', job_create: 'Zadanie utworzone', claim: 'Zadanie przejęte', ack: 'Wynik wykonawcy', reconcile: 'Ręczne rozstrzygnięcie', };

export function PrintJobsPanel(props: { contextKey: string; readOnly: boolean; orderId?: string; externalWriteBlocked?: boolean }) {
  const liveExternalWriteBlocked = useRef(props.externalWriteBlocked);
  liveExternalWriteBlocked.current = props.externalWriteBlocked;
  const identity = `${props.contextKey}:${props.readOnly}:${props.orderId ?? ''}`;
  const scope = useRef(identity); scope.current = identity;
  const generation = useRef(0), alive = useRef(false), fileInput = useRef<HTMLInputElement>(null);
  const [, redraw] = useState(0);
  const [options, setOptions] = useState<Options | null>(null), [printers, setPrinters] = useState<Printer[]>([]);
  const [loaded, setLoaded] = useState(''), [loadedEpoch, setLoadedEpoch] = useState(-1), [reading, setReading] = useState(false);
  const [error, setError] = useState(''), [success, setSuccess] = useState(''), [retryConsent, setRetryConsent] = useState(false);
  const [orderId, setOrderId] = useState(props.orderId ?? ''), [printerId, setPrinterId] = useState(''), [copies, setCopies] = useState('1');
  const [file, setFile] = useState<FileReview | null>(null), [review, setReview] = useState<Review | null>(null), [consent, setConsent] = useState(false), [reprintConsent, setReprintConsent] = useState(false);
  const [retryOf, setRetryOf] = useState<Job | null>(null), [blobUrl, setBlobUrl] = useState('');
  const [stationId, setStationId] = useState(''), [printerName, setPrinterName] = useState(''), [printerFormat, setPrinterFormat] = useState<'pdf' | 'zpl'>('pdf'), [outputMode, setOutputMode] = useState<'file' | 'cups'>('file'), [queue, setQueue] = useState('');
  const [jobs, setJobs] = useState<Job[]>([]), [cursor, setCursor] = useState<string | null>(null), [detail, setDetail] = useState<Detail | null>(null);
  const [resolveResult, setResolveResult] = useState<'unknown' | 'cancelled'>('unknown'), [resolveNote, setResolveNote] = useState(''), [resolveConsent, setResolveConsent] = useState(false);
  const seenOutcome = useRef<WriteReply | null>(null);
  const current = (n: number, e: number, id = identity) => alive.current && generation.current === n && scope.current === id && actorContext === props.contextKey && epoch === e;
  const visible = loaded === identity && loadedEpoch === epoch;
  const locked = actorContext === props.contextKey && Boolean(pending || inFlight || recoveryError);
  const busy = reading || (actorContext === props.contextKey && inFlight);
  const writable = visible && !!options?.available && !!options.can_write && !options.read_only && !props.readOnly;
  const freshBlocked = !writable || locked || reading || !!props.externalWriteBlocked;
  function invalidate() { setReview(null); setConsent(false); setReprintConsent(false); setResolveConsent(false); setSuccess(''); }
  function purge() { setOptions(null); setPrinters([]); setJobs([]); setDetail(null); setCursor(null); setFile(null); setReview(null); setConsent(false); setReprintConsent(false); setResolveConsent(false); setResolveNote(''); setRetryOf(null); setPrinterName(''); setQueue(''); setStationId(''); setPrinterId(''); setOrderId(props.orderId ?? ''); setCopies('1'); if (fileInput.current) fileInput.current.value = ''; }
  function fail(err: unknown) {
    if (err instanceof ApiError && [401, 403].includes(err.status)) { purgePrintJobsAccess(props.contextKey); setReading(false); purge(); }
    if (err instanceof ApiError && err.status === 503) { purge(); }
    setError(err instanceof Error ? err.message : 'Nie udało się odczytać drukowania.');
  }
  async function actor() {
    const r = await api<{ user: { tenant_id: string; id: string; role: string } }>('/auth/me');
    const parts = props.contextKey.split(':');
    if (parts.length !== 4 || !uuid(parts[0]) || !uuid(parts[1]) || !['true', 'false'].includes(parts[3]) || !r.user || `${r.user.tenant_id}:${r.user.id}:${r.user.role}` !== parts.slice(0, 3).join(':')) throw new ApiError('Kontekst drukowania zmienił się. Otwórz panel ponownie.', 403);
  }
  async function access() {
    await actor();
    const o = await api<Options>('/print-jobs/options'); checkFlags(o);
    if (o.available && !o.can_read) throw new ApiError('Brak bieżącego dostępu do drukowania.', 403);
    if (o.available && (!Array.isArray(o.stations) || o.stations.length > 100 || o.stations.some((s) => !uuid(s.id) || !validVersion(s.version) || typeof s.enabled !== 'boolean',) || new Set(o.stations.map((s) => s.id)).size !== o.stations.length)) throw Error('Niepełna lista własnych stanowisk.');
    await actor(); return o;
  }
  async function allPrinters(o: Options) {
    if (!o.available) return [];
    const rows: Printer[] = [], seen = new Set<string>(); let next: string | null = null;
    for (let page = 0; page < 3; page++) {
      const r: Flags & { printers: Printer[]; next_cursor: string | null } = await api('/print-jobs/printers' + (next ? '?cursor=' + encodeURIComponent(next) : ''),);
      checkFlags(r);
      if (!r.available || !r.can_read || r.current_role !== o.current_role || r.read_only !== o.read_only || r.can_write !== o.can_write || r.can_manage !== o.can_manage || !Array.isArray(r.printers) || r.printers.length > 50 || (r.next_cursor !== null && (!uuid(r.next_cursor) || seen.has(r.next_cursor)))) throw Error('Dostęp lub kompletność listy drukarek zmieniły się.');
      for (const p of r.printers) { checkPrinter(p); if (rows.some((v) => v.id === p.id)) throw Error('Powtórzona drukarka na liście.'); rows.push(p); }
      if (rows.length > 100) throw Error('Przekroczony zakres drukarek.');
      if (!r.next_cursor) return rows;
      if (!r.printers.length) throw Error('Niepełna strona drukarek.');
      seen.add(r.next_cursor); next = r.next_cursor;
    }
    throw Error('Nie udało się odczytać pełnej listy drukarek.');
  }
  async function read<T>(run: (o: Options) => Promise<T>, force = false): Promise<T | null> {
    if ((!force && reading) || inFlight) return null;
    const n = ++generation.current, e = epoch, id = identity; setReading(true); setError('');
    try { const o = await access(); if (!current(n, e, id)) return null; const result = await run(o); const last = await access(); if (!current(n, e, id)) return null; setOptions(last); setLoaded(id); setLoadedEpoch(e); return result; }
    catch (err) { if (current(n, e, id)) fail(err); return null; }
    finally { if (alive.current && scope.current === id && generation.current === n) setReading(false); }
  }
  async function refresh(force = false) {
    const result = await read(allPrinters, force); if (result) { setPrinters(result); invalidate(); }
  }
  async function write(a: Attempt, retry = false) {
    if (a.recoveryOnly || recoveryError || !['printer', 'job', 'reconcile'].includes(a.kind) ||
      !writable || inFlight || reading || (retry ? pending !== a : freshBlocked)) return;
    const n = ++generation.current, e = epoch, id = identity; inFlight = true; publish(); setError(''); setSuccess(''); setRetryConsent(false); let sent = false;
    try {
      const o = await access(); if (!current(n, e, id)) return;
      setOptions(o);
      if (!o.available || !o.can_write || o.read_only || props.readOnly || (a.kind !== 'job' && (!o.can_manage || o.current_role !== 'admin'))) throw new ApiError('Brak aktualnego dostępu do zapisu drukowania.', o.read_only || props.readOnly ? 423 : 403,);
      if (liveExternalWriteBlocked.current) throw Error('Zapis drukowania jest zablokowany przez inną zachowaną próbę.');
      persistPrintAttempt(a); pending = a; sent = true; publish();
      const result = await api<WriteReply>(a.path, 'POST', JSON.parse(a.body));
      if (actorContext !== a.context || epoch !== e) return;
      await checkWrite(result, a);
      acknowledgePrint(a, result);
      const last = await access(); if (actorContext !== a.context || epoch !== e) return;
      if (!last.available || !last.can_read) throw new ApiError('Dostęp do wyniku drukowania zmienił się.', 403);
      outcome = { context: a.context, kind: a.kind, reply: result, attempt: a }; pending = null; publish();
      if (current(n, e, id)) { setOptions(last); setLoaded(id); setLoadedEpoch(e); consume(outcome); }
    } catch (err) {
      if (actorContext !== a.context || epoch !== e) return;
      if (sent && err instanceof ApiError && err.status < 500 && ![401,403,408,429].includes(err.status)) { forgetPrintRefusal(a); pending = null; if (current(n, e, id)) { invalidate(); setRetryConsent(false); } }
      if (current(n, e, id)) fail(err);
    } finally { if (actorContext === a.context && epoch === e) { inFlight = false; if (!sent && !retry) pending = null; publish(); } }
  }
  function submit(kind: Attempt['kind'], path: string, body: Record<string, unknown>) { if (!freshBlocked) void write({ context: props.contextKey, kind, path, body: JSON.stringify({ ...body, client_key: crypto.randomUUID() }), }); }
  function consume(value: NonNullable<typeof outcome>) {
    if (!['printer', 'job', 'reconcile'].includes(value.kind)) return;
    if (seenOutcome.current === value.reply) return;
    seenOutcome.current = value.reply; invalidate();
    if (value.reply.printer) { setPrinters((old) => [value.reply.printer!, ...old.filter((p) => p.id !== value.reply.printer!.id),]); setSuccess('Drukarka zapisana.'); }
    if (value.reply.job) { setDetail({ ...value.reply, job: value.reply.job, events: value.reply.events ?? (value.reply.event ? [value.reply.event] : []), }); setSuccess(value.kind === 'job' ? 'Zadanie zapisane w kolejce. Nie oznacza to wydruku na papierze.' : 'Rozstrzygnięcie zadania zapisane.',); setFile(null); setRetryOf(null); if (fileInput.current) fileInput.current.value = ''; }
  }
  useEffect(() => {
    alive.current = true; resetPrintJobsContext(props.contextKey);
    const notify = () => redraw((v) => v + 1); listeners.add(notify);
    return () => { alive.current = false; generation.current++; listeners.delete(notify); };
  }, [props.contextKey, props.readOnly, props.orderId]);
  useEffect(() => { generation.current++; purge(); setReading(false); setLoaded(''); setError(''); setSuccess(''); setRetryConsent(false); seenOutcome.current = null; void refresh(true); }, [identity]);
  useEffect(() => { if (loadedEpoch !== epoch) purge(); if (visible && outcome?.context === props.contextKey) consume(outcome); }, [visible, loadedEpoch, epoch, outcome]);
  useEffect(() => {
    if (!file || !review || review.printer.format !== 'pdf') { setBlobUrl(''); return; }
    const url = URL.createObjectURL(new Blob([file.data as BlobPart], { type: 'application/pdf' })); setBlobUrl(url); return () => URL.revokeObjectURL(url);
  }, [file, review]);
  async function loadFile(selected: File | undefined) {
    if (freshBlocked || !selected) return;
    const p = printers.find((v) => v.id === printerId); if (!p) { setError('Najpierw wybierz drukarkę i format.'); return; }
    const n = ++generation.current, e = epoch, id = identity; invalidate(); setFile(null); setReading(true);
    try { const f = await readFile(selected, p.format); if (current(n, e, id)) setFile(f); }
    catch (err) { if (current(n, e, id)) fail(err); }
    finally { if (alive.current && scope.current === id && generation.current === n) setReading(false); }
  }
  async function prepare() {
    if (freshBlocked || !file || !uuid(orderId) || !/^(?:[1-9]|10)$/.test(copies)) return;
    invalidate(); const capturedFile = file, capturedPrinter = printerId, capturedOrder = orderId, capturedCopies = Number(copies), capturedRetry = retryOf;
    const result = await read(async (o) => {
      if (!o.available || !o.can_write || o.read_only || props.readOnly) throw new ApiError('Brak aktualnego dostępu do kolejki.', 403);
      const ps = await allPrinters(o), p = ps.find((v) => v.id === capturedPrinter), s = o.stations.find((v) => v.id === p?.station_id);
      if (!p?.enabled || !s?.enabled) throw Error('Drukarka lub jej stanowisko jest wyłączone.');
      if (p.format !== capturedFile.format) throw Error('Format drukarki zmienił się. Wybierz plik ponownie i przygotuj świeży podgląd.',);
      const order = await api<{ id: string; number: string; version: string | number }>('/orders/' + capturedOrder,);
      const v = String(order.version); if (order.id !== capturedOrder || !validVersion(v) || (typeof order.version === 'number' && !Number.isSafeInteger(order.version))) throw Error('Niepełna bieżąca wersja własnego zamówienia.');
      if (capturedRetry && (capturedRetry.order_id !== order.id || capturedRetry.content_sha256 !== capturedFile.sha256)) throw Error('Ponowny druk wymaga tego samego zamówienia i dokładnie tego samego pliku.');
      return { file: capturedFile, order: { ...order, version: v }, printer: p, station: s, copies: capturedCopies, retryOf: capturedRetry, };
    });
    if (result) setReview(result);
  }
  function queueJob() {
    if (freshBlocked || !review || !consent || (review.retryOf && !reprintConsent)) return;
    submit('job', '/print-jobs/jobs', { order_id: review.order.id, order_version: review.order.version, station_id: review.station.id, station_version: review.station.version, printer_id: review.printer.id, printer_version: review.printer.version, source_kind: 'manual', format: review.printer.format, content_base64: review.file.base64, copies: review.copies, confirmed: true, ...(review.retryOf ? { retry_of_job_id: review.retryOf.id, reprint_confirmed: true } : {}), });
  }
  function registerPrinter() {
    const station = options?.stations.find((s) => s.id === stationId);
    if (freshBlocked || !options?.can_manage || options.current_role !== 'admin' || !station?.enabled || !printerName.trim() || (outputMode === 'cups' && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(queue))) return;
    submit('printer', '/print-jobs/printers', { station_id: station.id, station_version: station.version, name: printerName.trim(), format: printerFormat, output_mode: outputMode, cups_queue: outputMode === 'cups' ? queue : null, enabled: true, });
  }
  async function history(next?: string) {
    const result = await read(async (o) => { if (!o.available) throw Error('Moduł drukowania jest niedostępny.'); const query = new URLSearchParams({ ...(next ? { cursor: next } : {}), ...(props.orderId ? { order_id: props.orderId } : {}), }); const r = await api<Flags & { jobs: Job[]; next_cursor: string | null }>('/print-jobs/jobs' + (query.size ? '?' + query : ''),); checkFlags(r); if (!r.can_read || !r.available) throw new ApiError('Brak bieżącego dostępu do historii zadań.', 403); if (!Array.isArray(r.jobs) || r.jobs.length > 50 || new Set(r.jobs.map((j) => j.id)).size !== r.jobs.length || (r.next_cursor !== null && (!uuid(r.next_cursor) || r.next_cursor === next)) || (props.orderId && r.jobs.some((j) => j.order_id !== props.orderId))) throw Error('Niepełna historia zadań.'); r.jobs.forEach(checkJob); return r; });
    if (result) { setJobs((old) => next ? [...old, ...result.jobs.filter((j) => !old.some((v) => v.id === j.id))] : result.jobs,); setCursor(result.next_cursor); }
  }
  async function openJob(id: string) {
    if (!uuid(id)) return;
    const result = await read(async (o) => { if (!o.available) throw Error('Moduł drukowania jest niedostępny.'); const r = await api<Detail>('/print-jobs/jobs/' + id); checkFlags(r); if (!r.can_read || !r.available) throw new ApiError('Brak bieżącego dostępu do zadania.', 403); checkJob(r.job); checkEvents(r.events); if (r.job.id !== id) throw Error('Odczytano inne zadanie.'); return r; });
    if (result) { setDetail(result); setResolveConsent(false); setResolveNote(''); }
  }
  async function recoverKnownResult() {
    const held = recovery;
    if (!held) return;
    const result = await read(async o => {
      if (!o.available || !o.can_read) throw new ApiError('Brak aktualnego odczytu wyniku.',403);
      const endpoint=originalKeyLocation(held);
      const receipt=await api<Flags & {recovery:unknown}>(endpoint.path);
      checkFlags(receipt);
      if (!receipt.available || !receipt.can_read || receipt.current_role!==o.current_role || receipt.read_only!==o.read_only) throw new ApiError('Dostęp do oryginalnego wyniku zmienił się.',403);
      const {proof,known}=confirmOriginalKey(held,receipt.recovery,props.contextKey);
      if (endpoint.kind==='printer') {
        const rows=await allPrinters(o), printer=rows.find(p=>p.id===known.resource);
        if (!printer || !matchesRecovery(known,printer.id,printer.version,null,[proof.receipt_id])) throw Error('Nie potwierdzono oryginalnej drukarki w pełnej bieżącej liście.');
        return {printer};
      }
      const d=await api<Detail>('/print-jobs/jobs/'+known.resource);
      checkFlags(d);checkJob(d.job);checkEvents(d.events);
      const event=d.events.find(e=>e.id===proof.receipt_id);
      if (!d.available || !d.can_read || d.current_role!==o.current_role || d.read_only!==o.read_only || !matchesRecovery(known,d.job.id,d.job.version,d.job.order_id,d.events.map(e=>e.id),d.job.content_sha256) ||
          !event || event.operation!==proof.operation || event.version_after!==proof.receipt_version) throw Error('Odczyt nie potwierdza oryginalnego zadania i niezmiennego zdarzenia.');
      return {detail:d};
    });
    if (!result || recovery!==held || actorContext!==props.contextKey) return;
    if ('detail' in result && ['unknown','failed'].includes(result.detail!.job.state)) {
      setDetail(result.detail!);setError('Odczytano oryginalne zadanie, ale wynik drukowania wymaga wyjaśnienia. Nie potwierdzono fizycznego wydruku; nowe zapisy pozostają wstrzymane.');return;
    }
    try { browserRecovery.clear(held);recovery=null;pending=null;publish();
      if ('detail' in result) setDetail(result.detail!);
      setSuccess('Odczytano potwierdzony oryginalny wynik bez ponawiania zapisu. Nie potwierdza to fizycznego wydruku.');
    } catch(err){setError(err instanceof Error?err.message:'Nie udało się zachować wyniku odczytu.');}
  }
  function resolve() {
    if (freshBlocked || !detail?.job.can_reconcile || !options?.can_manage || options.current_role !== 'admin' || !resolveConsent || resolveNote.trim().length < 3 || resolveNote.trim().length > 500) return;
    submit('reconcile', `/print-jobs/jobs/${detail.job.id}/reconcile`, { version: detail.job.version, result: detail.job.state === 'queued' ? 'cancelled' : resolveResult, confirmed: true, note: resolveNote.trim(), }); setResolveConsent(false);
  }
  if (!visible) return ( <section className="panel print-jobs-panel"><h2>Trwała kolejka drukowania</h2>{error && ( <p className="error" role="alert">{error}</p>
        )}<button className="button" disabled={busy} onClick={() => void refresh()}>Odczytaj dostęp do drukowania</button></section>
    );
  return ( <section className="panel print-jobs-panel" aria-label="Trwała kolejka drukowania">
    <PackedLabelPrintPanel externalWriteBlocked={props.externalWriteBlocked} contextKey={props.contextKey} readOnly={props.readOnly} orderId={props.orderId} />
    <h2>Trwała kolejka drukowania</h2><p>Ręcznie dostarczony plik PDF lub ZPL. Zapis pliku albo przekazanie do CUPS nie potwierdza fizycznego wydruku.</p>
    {error && ( <p className="error" role="alert">{error}</p>
      )}{success && <p role="status">{success}</p>}
    {!options?.available && <p>Ta kopia nie zawiera modułu kolejki drukowania.</p>}
    {(props.readOnly || options?.read_only) && ( <p>Ten widok jest tylko do odczytu — nowe zadania i rozstrzygnięcia są zablokowane.</p>
      )}
    {recoveryError && <p role="alert">{recoveryError} Nowe zapisy są wstrzymane.</p>}
    {pending?.context === props.contextKey && ( <div className="print-jobs-pending"><p>{pending.recoveryOnly ? 'Zachowano identyfikatory oryginalnej próby. Odczyt historii nie usuwa tej blokady.' : 'Wynik próby jest nierozstrzygnięty. Zachowano dokładną treść i klucz. Odczyt historii nie usuwa tej próby.'}</p>
          {!pending.recoveryOnly && recovery && <button className="button" disabled={busy} onClick={()=>void recoverKnownResult()}>Odczytaj oryginalny wynik bez ponawiania</button>}
          {pending.recoveryOnly ? <><p>Po przeładowaniu zachowano tylko identyfikatory. Treści dokumentu ani zgody nie odtworzono. Klucz: {recovery?.key ?? 'brak'} · wynik: {recovery?.resource ?? 'niepotwierdzony'}.</p><button className="button" disabled={busy} onClick={()=>void recoverKnownResult()}>Odczytaj oryginalny wynik bez ponawiania</button></> : ['printer', 'job', 'reconcile'].includes(pending.kind) ? (
            <><label><input type="checkbox" checked={retryConsent} disabled={busy || !writable} onChange={(e) => setRetryConsent(e.target.checked)} />{' '} Chcę ponowić dokładnie zachowaną próbę</label><button className="button" disabled={busy || !writable || !retryConsent} onClick={() => pending && void write(pending, true)}>Ponów tę samą próbę</button></>
          ) : (
            <p>
              {pending.kind.startsWith('packed_') ? 'Wróć do panelu druku po pakowaniu powyżej' : ['batch_preview', 'batch_queue'].includes(pending.kind) ? 'Wróć do zbiorczej kolejki etykiet' : 'Wróć do panelu etykiety tej przesyłki'}, aby ponowić dokładnie zachowaną próbę. Nowe
              zadania pozostają zablokowane.
            </p>
          )}
        </div>
      )}
    <button className="button" disabled={busy} onClick={() => void refresh()}>Odśwież dostęp i drukarki</button>
    {options?.available && ( <>
      <details><summary>Zarejestruj drukarkę · administrator</summary>
        <fieldset disabled={freshBlocked || !options.can_manage || options.current_role !== 'admin'}>
          <div className="print-jobs-grid">
            <label>Własne stanowisko pakowania<select value={stationId} onChange={(e) => setStationId(e.target.value)}><option value="">Wybierz aktywne stanowisko</option>{options.stations.filter((s) => s.enabled).map((s) => ( <option key={s.id} value={s.id}>{s.code} · {s.label}</option>
                      ))}</select></label>
            <label>Nazwa drukarki<input value={printerName} maxLength={120} onChange={(e) => setPrinterName(e.target.value)} /></label>
            <label>Format<select value={printerFormat} onChange={(e) => setPrinterFormat(e.target.value as 'pdf' | 'zpl')}><option value="pdf">PDF</option><option value="zpl">ZPL</option></select></label>
            <label>Wyjście<select value={outputMode} onChange={(e) => { setOutputMode(e.target.value as 'file' | 'cups'); setQueue(''); }}><option value="file">Plik lokalny</option><option value="cups">Kolejka CUPS na komputerze bridge</option></select></label>
            {outputMode === 'cups' && ( <label>Nazwa kolejki CUPS na komputerze bridge<input value={queue} maxLength={64} pattern="[A-Za-z0-9][A-Za-z0-9_.-]{0,63}" onChange={(e) => setQueue(e.target.value)} /></label>
                )}
          </div>
          {!options.stations.some((s) => s.enabled) && ( <p>Najpierw skonfiguruj własne aktywne stanowisko w ustawieniach pakowania.</p>
              )}
          {outputMode === 'cups' && ( <p>Nazwa jest konfiguracją; dostępność sprawdza lokalny bridge. Rejestracja nie uruchamia wydruku. Dozwolone są litery, cyfry, kropka, podkreślenie i myślnik, bez ścieżek lub poleceń.</p>
              )}
          <button className="button" disabled={!printerName.trim() || !stationId || (outputMode === 'cups' && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(queue))} onClick={registerPrinter}>Zapisz drukarkę</button>
        </fieldset>
      </details>
      <fieldset disabled={freshBlocked}><legend>Nowe zadanie z ręcznego pliku</legend><div className="print-jobs-grid"><label>Zamówienie · własny identyfikator<input value={orderId} disabled={!!props.orderId} onChange={(e) => { setOrderId(e.target.value.trim()); setRetryOf(null); invalidate(); }} /></label><label>Drukarka<select value={printerId} onChange={(e) => { setPrinterId(e.target.value); setFile(null); if (fileInput.current) fileInput.current.value = ''; invalidate(); }}><option value="">Wybierz aktywną drukarkę</option>{printers.filter((p) => p.enabled && options.stations.some((s) => s.id === p.station_id && s.enabled),).map((p) => ( <option key={p.id} value={p.id}>{p.name} · {p.format.toUpperCase()} · {' '}
                        {p.output_mode === 'file' ? 'plik lokalny' : 'CUPS'}</option>
                    ))}</select></label><label>Liczba kopii<input type="number" min={1} max={10} step={1} value={copies} onChange={(e) => { setCopies(e.target.value); invalidate(); }} /></label><label>Plik · maksymalnie 2 MiB<input ref={fileInput} type="file" accept={printers.find((p) => p.id === printerId)?.format === 'zpl' ? '.zpl,text/plain' : '.pdf,application/pdf'} onChange={(e) => void loadFile(e.target.files?.[0])} /></label></div>{file && ( <p>{file.name} · {file.bytes} bajtów · SHA-256 {file.sha256}</p>
            )}{retryOf && ( <p>Ponowny druk zadania dla {retryOf.order_number}. Wybierz dokładnie ten sam plik; powstanie nowe zadanie.</p>
            )}<button className="button" disabled={!file || !uuid(orderId)} onClick={() => void prepare()}>Przygotuj pełny podgląd pliku i zadania</button></fieldset>
      {review && ( <div className="print-jobs-review">
        <h3>Pełny podgląd ręcznego zadania</h3>
        <p>Zamówienie {review.order.number} · wersja {review.order.version} ·{' '} {review.station.label} · {review.printer.name} · {review.copies} kopii</p>
        <p>{review.file.name} · {review.file.bytes} bajtów · SHA-256 {review.file.sha256}</p>
        <p>{review.printer.output_mode === 'file' ? 'Wyjście: plik lokalny. Nie jest to wydruk na papierze.' : `Wyjście: skonfigurowana kolejka CUPS ${review.printer.cups_queue}. Przyjęcie przez CUPS nie potwierdza wydruku.`}</p>
        {review.printer.format === 'pdf' ? ( <div className="print-jobs-pdf-preview">
          <p>Sprawdź cały PDF w osobnej karcie przed potwierdzeniem zadania. Podgląd nie uruchamia drukowania.</p>
          {blobUrl ? ( <a className="button" href={blobUrl} target="_blank" rel="noreferrer noopener">Otwórz pełny podgląd PDF w osobnej karcie</a>
                  ) : ( <p>Przygotowywanie odnośnika do PDF…</p>
                  )}
        </div>
              ) : ( <pre>{review.file.text}</pre>
              )}
        <p>Plik nie jest zweryfikowaną etykietą od przewoźnika. Serwer sprawdzi dopuszczalność PDF/ZPL przed zapisem.</p>
        <label><input type="checkbox" checked={consent} disabled={freshBlocked} onChange={(e) => setConsent(e.target.checked)} />{' '} Sprawdziłem cały plik, zamówienie, drukarkę i kopie. Zapisz to zadanie w kolejce.</label>
        {review.retryOf && ( <label><input type="checkbox" checked={reprintConsent} disabled={freshBlocked} onChange={(e) => setReprintConsent(e.target.checked)} />{' '} Potwierdzam ponowny druk jako nowe zadanie; poprzednie mogło zostać wydrukowane.</label>
              )}
        <button className="button primary" disabled={freshBlocked || !consent || (!!review.retryOf && !reprintConsent)} onClick={queueJob}>Zapisz zadanie w kolejce</button>
      </div>
          )}
      <div className="print-jobs-history"><h3>Historia zadań</h3><button className="button" disabled={busy} onClick={() => void history()}>Odczytaj historię zadań</button>{jobs.map((j) => ( <button className="button" key={j.id} disabled={busy} onClick={() => void openJob(j.id)}>{printJobSourceName(j)} · {stateNames[j.state] ?? j.state} · {j.copies} kopii · {' '}
                {date(j.created_at)}</button>))}{cursor && ( <button className="button" disabled={busy} onClick={() => void history(cursor)}>Starsze zadania</button>
            )}</div>
      {detail && ( <article>
        <h3>Zadanie: {printJobSourceName(detail.job)}</h3>
        {detail.job.source_kind==='picking_wave'&&<p>Lista całej partii · {detail.job.wave_snapshot.orders.length} zamówień. Zadania całej partii nie można ponowić formularzem pojedynczego zamówienia.</p>}
        <p>{stateNames[detail.job.state]} · wersja {detail.job.version} · {' '}
                {detail.job.printer_snapshot.name} · {detail.job.copies} kopii ·{' '} {detail.job.format.toUpperCase()}</p>
        <p>{detail.job.content_bytes} bajtów · SHA-256 {detail.job.content_sha256}</p>
        {detail.job.state === 'file_saved' && ( <p>Zapisano plik lokalnie; brak potwierdzenia fizycznego wydruku.</p>
              )}
        {detail.job.state === 'spool_submitted' && ( <p>CUPS przyjął zadanie; nie potwierdzono wydruku na papierze.</p>
              )}
        {detail.job.state === 'unknown' && ( <p>Poprzednia próba mogła zostać wydrukowana. Uzgodnij wynik z operatorem przed nowym zadaniem.</p>
              )}
        <button className="button" disabled={busy} onClick={() => void openJob(detail.job.id)}>Odczytaj aktualny wynik i zdarzenia</button>
        <details><summary>Zdarzenia zadania ({detail.events.length})</summary>{detail.events.map((e) => ( <p key={e.id}>{date(e.created_at)} · {operationNames[e.operation]} · wersja{' '} {e.version_before ?? 'brak'} → {e.version_after}{e.result?.receipt?.note ? ` · ${e.result.receipt.note}` : ''}{e.result?.receipt?.artifact_name ? ` · plik lokalny: ${e.result.receipt.artifact_name}` : ''}{e.result?.receipt?.spool_job_id ? ` · zadanie CUPS: ${e.result.receipt.spool_job_id}` : ''}{e.result?.receipt?.error_code ? ` · kod odmowy: ${e.result.receipt.error_code}` : ''}</p>))}</details>
        {detail.job.can_reconcile && ( <fieldset disabled={freshBlocked || !options.can_manage || options.current_role !== 'admin'}>
          <legend>{detail.job.state === 'queued' ? 'Anuluj zadanie oczekujące · administrator' : 'Rozstrzygnij wygasłe przejęcie · administrator'}</legend>
          <p>{detail.job.state === 'queued' ? 'Anulowanie zatrzyma oczekujące zadanie. Nie uruchamia drukowania.' : 'Wykonawca mógł już wydrukować zadanie. Ta decyzja nie potwierdza papieru ani nie uruchamia ponownego druku.'}</p>
          {detail.job.state !== 'queued' && ( <label>Wynik<select value={resolveResult} onChange={(e) => { setResolveResult(e.target.value as 'unknown' | 'cancelled'); setResolveConsent(false); }}><option value="unknown">Wynik nieznany</option><option value="cancelled">Anuluj dalszą obsługę</option></select></label>
                  )}
          <label>Notatka<input value={resolveNote} minLength={3} maxLength={500} onChange={(e) => { setResolveNote(e.target.value); setResolveConsent(false); }} /></label>
          <label><input type="checkbox" checked={resolveConsent} onChange={(e) => setResolveConsent(e.target.checked)} />{' '} {detail.job.state === 'queued' ? 'Potwierdzam anulowanie oczekującego zadania.' : 'Rozumiem, że zadanie mogło być już wydrukowane.'}</label>
          <button className="button" disabled={!resolveConsent || resolveNote.trim().length < 3} onClick={resolve}>Zapisz rozstrzygnięcie</button>
        </fieldset>
              )}
        {detail.job.source_kind !== 'shipment_label' && detail.job.source_kind !== 'picking_wave' &&!['queued', 'claimed'].includes(detail.job.state) && (!props.orderId || detail.job.order_id === props.orderId) && ( <button className="button" disabled={freshBlocked} onClick={() => { const original=detail.job;if(original.source_kind==='picking_wave')return;setRetryOf(original); setOrderId(original.order_id); setPrinterId(detail.job.printer_id); setCopies(String(detail.job.copies)); setFile(null); if (fileInput.current) fileInput.current.value = ''; invalidate(); }}>Przygotuj ponowny druk jako nowe zadanie</button>
                )}
      </article>
          )}
    </>
      )}
  </section>
  );
}
