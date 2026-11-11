import { useEffect, useRef, useState } from 'react';
import { api, ApiError, date, statusNames } from './api';
import {
  PackingMeasurementsForm,
  validatePackingMeasurementsDraft,
  type PackingMeasurements,
  type PackingMeasurementsDraft,
  type PackingCartonSeed,
} from './packing-measurements';
import { packingUnitText } from './packing-measurements-input';
import './packing-workstation.css';
import { BarcodeScanner, onScanSuffix, submitForm } from './barcode-scanner';
import { PackingPhotoPanel } from './packing-photos';
import { PackingOrderFields, type PackingOrderFieldDetail } from './packing-order-fields';

type Flags = {
  available: boolean;
  read_only: boolean;
  current_role: string;
  can_read: boolean;
  can_write: boolean;
  can_admin: boolean;
};
type Policy = { version: string; require_parcel_profile: boolean };
type Metadata = Flags & { policy: Policy; limits: Record<string, number>; units: { weight: 'g'; dimensions: 'mm' } };
type Station = { id: string; code: string; label: string; enabled: boolean; version: string };
type Dimensions = { length_mm: number; width_mm: number; height_mm: number };
type Carton = Station & { inner_dimensions: Dimensions; outer_dimensions: Dimensions; tare_grams: number };
type Page<T> = Flags & { data: T[]; meta: { cursor: string | null } };
type OrderHead = { id: string; number: string; version: string; status: string; warehouse_id: string };
type Candidate = OrderHead & { quantity: number; scanned: number; active_wave_id: string | null; active_session_id: string | null; eligible: boolean; blockers: string[] };
type Session = { id: string; order_id: string; station_id: string; owner_id: string; owner_name: string; state: 'active' | 'finished' | 'cancelled'; version: string; lease_generation: string; expires_at: string; created_at: string };
type Profile = { revision: string; receipt_id: string; scope_hash: string; current: boolean; stale_reasons: string[] };
type SessionDetail = Flags & { session: Session; order: OrderHead; progress: { quantity: number; scanned: number; complete: boolean }; current_profile: Profile | null; active_wave_id: string | null; blockers: string[]; can_scan: boolean; can_finish: boolean; can_takeover: boolean };
type PhysicalItem = { product_id: string; order_sku: string; current_sku: string; order_ean?: string | null; current_ean?: string | null; name: string; quantity: number; scanned: number; reference?: unknown };
type Packaging = { kind: 'carton'; carton_id: string; carton_version: string; carton_snapshot?: Carton } | { kind: 'custom'; label: string; reason: string };
type Preview = { id: string; kind: 'finish' | 'remeasure'; order_id: string; session_id: string | null; actor_id: string; scope_hash: string; created_at: string; expires_at: string; ready: boolean; issues: string[]; measurements: PackingMeasurements; packaging: Packaging; policy_version: string; order_version: string; scan_hash: string; payment_hash: string; automations_warning: { event: string; enabled_rule_ids?: string[]; may_enqueue: boolean; local_financial_fence_exit: boolean } | null };
type Receipt = { id: string; preview_id: string; kind: 'finish' | 'remeasure'; order_id: string; order_number: string; actor_id: string; actor_name: string; station_snapshot: Station; packaging: Packaging; measurements: PackingMeasurements; profile_revision: string; replaces_receipt_id: string | null; before_order_version: string; after_order_version: string; scope_hash: string; created_at: string };
type ScanResult = { id: string; session_id: string; order_id: string; product_id: string; scanned_code: string; location: string; quantity: number; scanned_before: number; scanned_after: number; before_session_version: string; after_session_version: string; order_version: string; created_at: string };
type FrozenDetail = Flags & { preview?: Preview; receipt?: Receipt; snapshot_summary: Record<string, unknown>; result?: { status: string; profile_revision: string; before_order_version: string; after_order_version: string } };
type Allocation = Record<string, unknown>;
const prefix = '/packing';
const emptyMeasurements = (): PackingMeasurementsDraft => ({ weight_kg: '', length_cm: '', width_cm: '', height_cm: '' });
const measurementsDraft = (m: PackingMeasurements): PackingMeasurementsDraft => ({ weight_kg: packingUnitText(m.weight_grams, 3), length_cm: packingUnitText(m.length_mm, 1), width_cm: packingUnitText(m.width_mm, 1), height_cm: packingUnitText(m.height_mm, 1) });
const cartonSeed = (c: Carton): PackingCartonSeed => ({ id: c.id, version: c.version, code: c.code, label: c.label, outer_length_mm: c.outer_dimensions.length_mm, outer_width_mm: c.outer_dimensions.width_mm, outer_height_mm: c.outer_dimensions.height_mm, tare_weight_grams: c.tare_grams });
const append = <T,>(a: T[], b: T[]) => [...a, ...b];
const version = (v: unknown): string => {
  if (typeof v === 'string' && /^(0|[1-9]\d*)$/.test(v)) return v;
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return String(v);
  throw new Error('Nie można odczytać dokładnej wersji zamówienia.');
};
const detailMessage = (e: unknown) => e instanceof Error ? e.message : 'Nie udało się wykonać operacji.';
class StalePackingRead extends Error {}
type Attempt = { path: string; method: string; body: Record<string, unknown>; headers: Record<string, string>; label: string; complete: (data: any) => void };
type StoredAttempt = Omit<Attempt, 'complete'>;
const storagePrefix = 'dyna.packing110.';
const storageActor = storagePrefix + 'actor';
const storageKey = (context: string, kind: string) => storagePrefix + encodeURIComponent(context) + '.' + kind;
function clearPackingStorage() {
  for (let i = sessionStorage.length - 1; i >= 0; --i) {
    const key = sessionStorage.key(i);
    if (key?.startsWith(storagePrefix)) sessionStorage.removeItem(key);
  }
}
function preparePackingStorage(context: string, readOnly: boolean) {
  if (readOnly) { clearPackingStorage(); return; }
  const prior = sessionStorage.getItem(storageActor);
  if (prior && prior !== context) clearPackingStorage();
  sessionStorage.setItem(storageActor, context);
}
function restoreAttempt(context: string): StoredAttempt | null {
  const raw = sessionStorage.getItem(storageKey(context, 'pending'));
  if (!raw) return null;
  const a = JSON.parse(raw) as StoredAttempt;
  const uuid = '[a-f0-9-]{36}';
  const path = new RegExp('^/packing/(?:stations(?:/' + uuid + ')?|cartons(?:/' + uuid + ')?|policy|sessions(?:/' + uuid + '/(?:renew|takeover|cancel|scans))?|previews(?:/' + uuid + '/finish)?)$');
  if (!path.test(a.path) || !['POST', 'PATCH'].includes(a.method) || !a.body || typeof a.body !== 'object' || typeof a.body.client_key !== 'string' || typeof a.label !== 'string' || !a.headers || Object.keys(a.headers).some(k => k !== 'X-Packing-Lease')) throw new Error('Zapisany zakres pakowania jest nieprawidłowy. Nie ponowiono żądania.');
  return a;
}
function writeAttempt(context: string, a: Attempt) {
  const { complete: _complete, ...stored } = a;
  sessionStorage.setItem(storageKey(context, 'pending'), JSON.stringify(stored));
}
function removeAttempt(context: string, a: Attempt | null) {
  const stored = restoreAttempt(context);
  if (!stored || (a && stored.body.client_key === a.body.client_key)) sessionStorage.removeItem(storageKey(context, 'pending'));
}
function readLeases(context: string): Map<string, string> {
  if (sessionStorage.getItem(storageActor) !== context) return new Map();
  const raw = sessionStorage.getItem(storageKey(context, 'leases'));
  const entries = raw ? JSON.parse(raw) : [];
  if (!Array.isArray(entries) || entries.some((v: unknown) => !Array.isArray(v) || v.length !== 2 || !v.every((x: unknown) => typeof x === 'string' && /^[a-f0-9-]{36}$/.test(x)))) throw new Error('Zapisane tokeny sesji są nieprawidłowe.');
  return new Map(entries as [string, string][]);
}
function rememberLease(context: string, id: string, token?: string) {
  if (sessionStorage.getItem(storageActor) !== context) throw new StalePackingRead();
  const map = readLeases(context);
  if (token) map.set(id, token); else map.delete(id);
  sessionStorage.setItem(storageKey(context, 'leases'), JSON.stringify([...map]));
}
function pendingLease(a: StoredAttempt): string | undefined {
  // An unacknowledged renewal must not discard the still-current old token.
  if (a.path.endsWith('/renew')) return a.headers['X-Packing-Lease'];
  return typeof a.body.lease_token === 'string' ? a.body.lease_token : a.headers['X-Packing-Lease'];
}

function usePackingIO(contextKey: string, readOnly: boolean, purge: () => void, rejected?: (status: number) => void, storageContext?: string, recovered?: (data: any, a: StoredAttempt) => void, externalWriteBlocked = false, refreshWriteBlocked = false) {
  const externalBlock = useRef(externalWriteBlocked); externalBlock.current = externalWriteBlocked;
  const refreshBlock = useRef(refreshWriteBlocked); refreshBlock.current = refreshWriteBlocked;
  const live = useRef(false), epoch = useRef(0), gate = useRef(false), attemptRef = useRef<Attempt | null>(null);
  const purgeRef = useRef(purge); purgeRef.current = purge;
  const rejectedRef = useRef(rejected); rejectedRef.current = rejected;
  const recoveredRef = useRef(recovered); recoveredRef.current = recovered;
  const role = useRef<string | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [blocked, setBlocked] = useState(false), [pending, setPending] = useState<Attempt | null>(null);
  const current = (e: number) => live.current && epoch.current === e;
  function denyAccess() {
    if (storageContext) { try { sessionStorage.removeItem(storageKey(storageContext, 'pending')); sessionStorage.removeItem(storageKey(storageContext, 'leases')); } catch { /* Do not read secrets after denial. */ } }
    ++epoch.current; gate.current = false; setBusy(false);
    attemptRef.current = null; setPending(null); setBlocked(true);
    purgeRef.current(); setError('Dostęp do danych pakowania został cofnięty. Otwórz panel ponownie po odświeżeniu uprawnień.');
  }
  function denial(e: unknown) {
    if (!(e instanceof ApiError)) return;
    if ([401, 403].includes(e.status)) {
      denyAccess();
    } else if (e.status === 423) setBlocked(true);
  }
  function accept(data: Partial<Flags>) {
    if (data.current_role && role.current && role.current !== data.current_role) {
      denyAccess();
      throw new ApiError('Zmieniły się uprawnienia użytkownika. Otwórz panel ponownie.', 403);
    }
    if (data.current_role) role.current = data.current_role;
    if (storageContext && data.can_write === false) {
      try { sessionStorage.removeItem(storageKey(storageContext, 'pending')); sessionStorage.removeItem(storageKey(storageContext, 'leases')); } catch { /* Never reuse a secret after permission loss. */ }
      attemptRef.current = null; setPending(null); setBlocked(true);
    }
    if (data.read_only) setBlocked(true);
  }
  async function get<T>(path: string, headers: Record<string, string> = {}): Promise<T> {
    const e = epoch.current;
    try {
      const data = await api<T>(path, 'GET', undefined, headers);
      if (!current(e)) throw new StalePackingRead();
      accept(data as Partial<Flags>);
      return data;
    } catch (err) {
      if (current(e)) denial(err);
      throw err;
    }
  }
  async function read(task: () => Promise<void>) {
    if (gate.current || !live.current) return;
    const e = epoch.current; gate.current = true; setBusy(true); setError('');
    try { await task(); }
    catch (err) { if (current(e) && !(err instanceof StalePackingRead)) setError(detailMessage(err)); }
    finally { if (current(e)) { gate.current = false; setBusy(false); } }
  }
  async function send(a: Attempt) {
    if (gate.current || !live.current || blocked || readOnly || externalBlock.current || (refreshBlock.current && !attemptRef.current)) return;
    const e = epoch.current; gate.current = true; setBusy(true); setError('');
    attemptRef.current = a; setPending(a);
    if (storageContext) {
      try { writeAttempt(storageContext, a); }
      catch { gate.current = false; setBusy(false); setError('Nie można zachować dokładnego żądania w pamięci tej karty. Nic nie wysłano. Sprawdź dostępność sessionStorage i ponów tę samą operację.'); return; }
    }
    try {
      const data = await api(a.path, a.method, a.body, a.headers);
      if (!current(e)) return;
      accept(data);
      a.complete(data);
      if (storageContext) { try { removeAttempt(storageContext, a); } catch { /* The acknowledged request may safely be replayed again. */ } }
      attemptRef.current = null; setPending(null);
    } catch (err) {
      if (!current(e)) return;
      denial(err);
      setError(detailMessage(err) + (err instanceof ApiError && err.status === 409 ? ' Konflikt zakresu lub wersji: odczytaj aktualny stan i zatwierdź nowy podgląd.' : ''));
      if (err instanceof ApiError) rejectedRef.current?.(err.status);
      if (err instanceof ApiError && [400, 401, 403, 404, 409, 413, 422, 423, 503].includes(err.status)) {
        if (storageContext) { try { removeAttempt(storageContext, a); } catch { /* No write occurred for this definite rejection. */ } }
        attemptRef.current = null; setPending(null);
      }
    } finally { if (current(e)) { gate.current = false; setBusy(false); } }
  }
  function mutate(path: string, method: string, body: Record<string, unknown>, label: string, complete: Attempt['complete'], headers: Record<string, string> = {}) {
    if (attemptRef.current || readOnly || blocked || externalBlock.current || refreshBlock.current) return;
    // Freeze the body before the first request; caller state may change on later renders.
    const frozen = JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
    if (new TextEncoder().encode(JSON.stringify(frozen)).byteLength > 65536) {
      setError('Całe żądanie przekracza 64 KiB. Nic nie zapisano; skróć teksty.'); return;
    }
    void send({ path, method, body: frozen, headers: { ...headers }, label, complete });
  }
  useEffect(() => {
    live.current = true; ++epoch.current; gate.current = false; role.current = null;
    attemptRef.current = null; setPending(null); setBusy(false); setError(''); setBlocked(readOnly);
    if (storageContext) {
      try {
        preparePackingStorage(storageContext, readOnly);
        if (!readOnly) {
          const saved = restoreAttempt(storageContext);
          if (saved) { const a: Attempt = { ...saved, complete: data => recoveredRef.current?.(data, saved) }; attemptRef.current = a; setPending(a); }
        }
      } catch (e) { setBlocked(true); setError(detailMessage(e)); }
    }
    return () => { live.current = false; ++epoch.current; gate.current = false; attemptRef.current = null; };
  }, [contextKey, readOnly]);
  return { get, read, mutate, busy, error, setError, blocked, pending, pendingRequest: () => attemptRef.current, denyAccess, isReading:()=>gate.current, locked: busy || blocked || readOnly || externalWriteBlocked || refreshWriteBlocked || !!pending, retry: () => { const a = attemptRef.current; if (a) void send(a); } };
}
type IO = ReturnType<typeof usePackingIO>;
async function allPages<T>(io: IO, path: string): Promise<T[]> {
  let rows: T[] = [], cursor: string | null = null;
  const seen = new Set<string>();
  do {
    const data: Page<T> = await io.get<Page<T>>(path + (cursor ? (path.includes('?') ? '&' : '?') + 'cursor=' + encodeURIComponent(cursor) : ''));
    rows = append(rows, data.data); cursor = data.meta.cursor;
    if (cursor && seen.has(cursor)) throw new Error('Serwer powtórzył kursor. Nie obcięto zakresu.');
    if (cursor) seen.add(cursor);
  } while (cursor);
  return rows;
}
function IONotice({ io }: { io: IO }) {
  const [found, setFound] = useState('');
  useEffect(() => setFound(''), [io.pending]);
  return <>
    {io.error && <p className="packing-error" role="alert">{io.error}</p>}
    {io.busy && <p role="status">Trwa operacja…</p>}
    {io.pending && !io.busy && <div className="packing-warning" role="alert">
      <strong>Wynik operacji „{io.pending.label}” wymaga sprawdzenia.</strong>
      <p>Zachowano dokładny zakres i klucz. Edycja jest zablokowana do jednoznacznego wyniku.</p>
      <button type="button" className="button" disabled={io.blocked} onClick={io.retry}>Ponów tę samą operację</button>
      {typeof io.pending.body.client_key === 'string' && !io.pending.path.includes('/previews') && <button type="button" className="button" onClick={() => void io.read(async () => {
        const d = await io.get<{ operation: { kind: string; created_at: string } }>(prefix + '/operations/' + encodeURIComponent(String(io.pending!.body.client_key)));
        setFound('Zapisany wynik operacji istnieje (' + date(d.operation.created_at) + '). Ponów tę samą operację, aby odebrać jej pełny rezultat.');
      })}>Sprawdź zapisany wynik</button>}
      {found && <p role="status">{found}</p>}
    </div>}
  </>;
}
function Availability({ meta, readOnly }: { meta: Metadata | null; readOnly: boolean }) {
  return <>{meta && !meta.available && <p className="packing-warning">Stanowisko pakowania jest niedostępne w tej kopii danych. Nie utworzono domyślnego profilu.</p>}{(readOnly || meta?.read_only) && <p className="packing-warning">Kopia tylko do odczytu — konfiguracja i operacje pakowania są zablokowane.</p>}</>;
}
function DimensionsText({ value }: { value: Dimensions }) {
  return <>{packingUnitText(value.length_mm, 1)} × {packingUnitText(value.width_mm, 1)} × {packingUnitText(value.height_mm, 1)} cm</>;
}
function MeasurementsText({ value }: { value: PackingMeasurements }) {
  return <span>{packingUnitText(value.weight_grams, 3)} kg · <DimensionsText value={value} /></span>;
}
function JsonDetails({ title, value }: { title: string; value: unknown }) {
  return <details className="packing-technical"><summary>{title}</summary><pre>{JSON.stringify(value, null, 2)}</pre></details>;
}

export type PackingParcelSeed = { receipt_id: string; scope_hash: string; profile_revision: string; order_id: string; measurements: PackingMeasurements; provider: 'inpost_courier' | 'dpd' };
export type PackingWorkstationPanelProps = { contextKey: string; readOnly: boolean; externalWriteBlocked?: boolean; orderId?: string; refresh?: number; onOrder?: (id: string) => void; onChanged?: () => void; onParcelSeed?: (seed: PackingParcelSeed) => void };
export type AdminPackingSettingsProps = { contextKey: string; readOnly: boolean; refresh?: number; onChanged?: () => void };

type CartonDraft = { code: string; label: string; enabled: boolean; inner: { length: string; width: string; height: string }; outer: { length: string; width: string; height: string }; tare: string };
const newCarton = (): CartonDraft => ({ code: '', label: '', enabled: true, inner: { length: '', width: '', height: '' }, outer: { length: '', width: '', height: '' }, tare: '' });
function cartonInput(d: CartonDraft) {
  function dims(v: CartonDraft['inner']): Dimensions {
    const check = validatePackingMeasurementsDraft({ weight_kg: '0,001', length_cm: v.length, width_cm: v.width, height_cm: v.height });
    if (!check.measurements) throw new Error(Object.values(check.errors).join(' '));
    return { length_mm: check.measurements.length_mm, width_mm: check.measurements.width_mm, height_mm: check.measurements.height_mm };
  }
  let tare: number;
  if (!/\s/.test(d.tare) && /^0(?:[.,]0{1,3})?$/.test(d.tare)) tare = 0;
  else {
    const check = validatePackingMeasurementsDraft({ weight_kg: d.tare, length_cm: '1', width_cm: '1', height_cm: '1' });
    if (!check.measurements) throw new Error('Masa kartonu: ' + check.errors.weight_kg);
    tare = check.measurements.weight_grams;
  }
  const inner = dims(d.inner), outer = dims(d.outer);
  if (Object.keys(inner).some((k) => inner[k as keyof Dimensions] > outer[k as keyof Dimensions])) throw new Error('Wymiar wewnętrzny nie może przekraczać odpowiadającego wymiaru zewnętrznego.');
  return { code: d.code, label: d.label, enabled: d.enabled, inner_dimensions: inner, outer_dimensions: outer, tare_grams: tare };
}

export function AdminPackingSettings({ contextKey, readOnly, refresh = 0, onChanged }: AdminPackingSettingsProps) {
  const [meta, setMeta] = useState<Metadata | null>(null), [stations, setStations] = useState<Station[]>([]), [cartons, setCartons] = useState<Carton[]>([]);
  const [stationId, setStationId] = useState(''), [stationDraft, setStationDraft] = useState({ code: '', label: '', enabled: true });
  const [cartonId, setCartonId] = useState(''), [draft, setDraft] = useState<CartonDraft>(newCarton), [policyConsent, setPolicyConsent] = useState(false);
  const [stationVersion, setStationVersion] = useState(''), [cartonVersion, setCartonVersion] = useState('');
  const [success, setSuccess] = useState('');
  const purge = () => { setMeta(null); setStations([]); setCartons([]); setStationId(''); setStationVersion(''); setStationDraft({ code: '', label: '', enabled: true }); setCartonId(''); setCartonVersion(''); setDraft(newCarton()); setPolicyConsent(false); setSuccess(''); };
  const io = usePackingIO(contextKey, readOnly, purge, () => setPolicyConsent(false), contextKey, recoveredSettings);
  function recoveredSettings(d: any, a: StoredAttempt) {
    if (d.station) {
      setStations(old => [d.station, ...old.filter(s => s.id !== d.station.id)]); setStationId(d.station.id); setStationVersion(d.station.version);
      setStationDraft({ code: d.station.code, label: d.station.label, enabled: d.station.enabled });
    }
    if (d.carton) {
      const c: Carton = d.carton;
      setCartons(old => [c, ...old.filter(v => v.id !== c.id)]); setCartonId(c.id); setCartonVersion(c.version);
      setDraft({ code: c.code, label: c.label, enabled: c.enabled, inner: { length: packingUnitText(c.inner_dimensions.length_mm, 1), width: packingUnitText(c.inner_dimensions.width_mm, 1), height: packingUnitText(c.inner_dimensions.height_mm, 1) }, outer: { length: packingUnitText(c.outer_dimensions.length_mm, 1), width: packingUnitText(c.outer_dimensions.width_mm, 1), height: packingUnitText(c.outer_dimensions.height_mm, 1) }, tare: packingUnitText(c.tare_grams, 3) });
    }
    if (d.policy) setMeta(old => old ? { ...old, policy: d.policy } : old);
    if (d.session) {
      if (typeof a.body.lease_token === 'string') rememberLease(contextKey, d.session.id, a.body.lease_token);
      else if (a.path.endsWith('/cancel')) rememberLease(contextKey, d.session.id);
    }
    if (d.result?.session_id && d.receipt) rememberLease(contextKey, d.result.session_id);
    saved('Odebrano zapisany wynik wcześniejszej operacji.');
  }
  async function load() {
    const m = await io.get<Metadata>(prefix); setMeta(m); setPolicyConsent(false);
    if (!m.available || !m.can_read) { setStations([]); setCartons([]); return; }
    const ss = await allPages<Station>(io, prefix + '/stations'), cs = await allPages<Carton>(io, prefix + '/cartons');
    setStations(ss); setCartons(cs);
  }
  useEffect(() => { purge(); void io.read(load); }, [contextKey, readOnly]);
  useEffect(() => { if (refresh && !io.pending) void io.read(load); }, [refresh]);
  const write = !!meta?.available && !!meta.can_admin && !io.locked;
  const selectedStation = stations.find(s => s.id === stationId), selectedCarton = cartons.find(c => c.id === cartonId);
  function saved(message: string) { setSuccess(message); setPolicyConsent(false); onChanged?.(); }
  function saveStation() {
    if (!write) return;
    io.mutate(prefix + '/stations' + (stationId ? '/' + stationId : ''), stationId ? 'PATCH' : 'POST', { client_key: crypto.randomUUID(), ...(stationId ? { version: stationVersion } : {}), ...stationDraft }, 'Zapis stanowiska', d => {
      setStations(old => [d.station, ...old.filter(s => s.id !== d.station.id)]); setStationId(d.station.id); setStationVersion(d.station.version); saved('Stanowisko zapisane.');
    });
  }
  function saveCarton() {
    if (!write) return;
    try {
      const body = cartonInput(draft);
      io.mutate(prefix + '/cartons' + (cartonId ? '/' + cartonId : ''), cartonId ? 'PATCH' : 'POST', { client_key: crypto.randomUUID(), ...(cartonId ? { version: cartonVersion } : {}), ...body }, 'Zapis kartonu', d => {
        setCartons(old => [d.carton, ...old.filter(c => c.id !== d.carton.id)]); setCartonId(d.carton.id); setCartonVersion(d.carton.version); saved('Karton zapisany.');
      });
    } catch (e) { io.setError(detailMessage(e)); }
  }
  return <section className="packing-workstation" aria-label="Ustawienia pakowania">
    <header className="packing-heading"><h2>Stanowiska i kartony</h2><button type="button" className="button" disabled={io.busy || !!io.pending} onClick={() => void io.read(load)}>Odśwież konfigurację</button></header>
    <Availability meta={meta} readOnly={readOnly} /><IONotice io={io} />{success && <p role="status">{success}</p>}
    {meta?.available && <>
      {!meta.can_admin && <p>Konfiguracja jest dostępna tylko do odczytu. Zmiany wprowadza administrator.</p>}
      <details className="packing-card"><summary>Odczyt wszystkich stanowisk i kartonów ({stations.length} / {cartons.length})</summary>
        <h3>Stanowiska</h3>{!stations.length && <p>Brak skonfigurowanych stanowisk. Administrator może utworzyć pierwsze stanowisko.</p>}
        {stations.map(s => <p key={s.id}>{s.code} — {s.label} · {s.enabled ? 'aktywne' : 'wyłączone'} · wersja {s.version}</p>)}
        <h3>Kartony</h3>{!cartons.length && <p>Brak skonfigurowanych kartonów.</p>}
        <div className="packing-table-wrap"><table className="packing-table"><thead><tr><th>Karton</th><th>Wewnątrz</th><th>Na zewnątrz</th><th>Masa opakowania</th><th>Stan / wersja</th></tr></thead><tbody>{cartons.map(c => <tr key={c.id}><td>{c.code} — {c.label}</td><td><DimensionsText value={c.inner_dimensions} /></td><td><DimensionsText value={c.outer_dimensions} /></td><td>{packingUnitText(c.tare_grams, 3)} kg</td><td>{c.enabled ? 'aktywny' : 'wyłączony'} · {c.version}</td></tr>)}</tbody></table></div>
      </details>
      <div className="packing-settings-grid">
        <fieldset disabled={!write}><legend>Stanowisko</legend>
          <label>Wybierz stanowisko do edycji<select value={stationId} onChange={e => { const s = stations.find(v => v.id === e.target.value); setStationId(e.target.value); setStationVersion(s?.version ?? ''); setStationDraft(s ? { code: s.code, label: s.label, enabled: s.enabled } : { code: '', label: '', enabled: true }); setSuccess(''); }}><option value="">Nowe stanowisko</option>{stations.map(s => <option key={s.id} value={s.id}>{s.code} — {s.label}{s.enabled ? '' : ' (wyłączone)'}</option>)}</select></label>
          <label>Kod stanowiska<input value={stationDraft.code} onChange={e => setStationDraft(d => ({ ...d, code: e.target.value }))} /></label>
          <label>Nazwa stanowiska<input value={stationDraft.label} onChange={e => setStationDraft(d => ({ ...d, label: e.target.value }))} /></label>
          <label className="packing-check"><input type="checkbox" checked={stationDraft.enabled} onChange={e => setStationDraft(d => ({ ...d, enabled: e.target.checked }))} />Stanowisko aktywne</label>
          {selectedStation && <><p>Wersja szkicu: {stationVersion}; aktualnie odczytana: {selectedStation.version}. Wyłączenie zachowuje historię.</p><button type="button" className="button" onClick={() => { setStationVersion(selectedStation.version); setStationDraft({ code: selectedStation.code, label: selectedStation.label, enabled: selectedStation.enabled }); }}>Zastąp szkic aktualnym stanowiskiem</button></>}
          <button type="button" className="button primary" onClick={saveStation}>Zapisz stanowisko</button>
        </fieldset>
        <fieldset disabled={!write}><legend>Karton</legend>
          <label>Wybierz karton do edycji<select value={cartonId} onChange={e => { const c = cartons.find(v => v.id === e.target.value); setCartonId(e.target.value); setCartonVersion(c?.version ?? ''); setDraft(c ? { code: c.code, label: c.label, enabled: c.enabled, inner: { length: packingUnitText(c.inner_dimensions.length_mm, 1), width: packingUnitText(c.inner_dimensions.width_mm, 1), height: packingUnitText(c.inner_dimensions.height_mm, 1) }, outer: { length: packingUnitText(c.outer_dimensions.length_mm, 1), width: packingUnitText(c.outer_dimensions.width_mm, 1), height: packingUnitText(c.outer_dimensions.height_mm, 1) }, tare: packingUnitText(c.tare_grams, 3) } : newCarton()); setSuccess(''); }}><option value="">Nowy karton</option>{cartons.map(c => <option key={c.id} value={c.id}>{c.code} — {c.label}{c.enabled ? '' : ' (wyłączony)'}</option>)}</select></label>
          <label>Kod kartonu<input value={draft.code} onChange={e => setDraft(d => ({ ...d, code: e.target.value }))} /></label>
          <label>Nazwa kartonu<input value={draft.label} onChange={e => setDraft(d => ({ ...d, label: e.target.value }))} /></label>
          {(['inner', 'outer'] as const).map(kind => <div key={kind}><h4>{kind === 'inner' ? 'Wymiary wewnętrzne' : 'Wymiary zewnętrzne'} (cm)</h4><div className="packing-three">{(['length', 'width', 'height'] as const).map(axis => <label key={axis}>{({ length: 'Długość', width: 'Szerokość', height: 'Wysokość' })[axis]} {kind === 'inner' ? 'wewnętrzna' : 'zewnętrzna'} (cm)<input inputMode="decimal" value={draft[kind][axis]} onChange={e => setDraft(d => ({ ...d, [kind]: { ...d[kind], [axis]: e.target.value } }))} /></label>)}</div></div>)}
          <label>Masa samego kartonu (kg, zero dozwolone)<input inputMode="decimal" value={draft.tare} onChange={e => setDraft(d => ({ ...d, tare: e.target.value }))} /></label>
          <label className="packing-check"><input type="checkbox" checked={draft.enabled} onChange={e => setDraft(d => ({ ...d, enabled: e.target.checked }))} />Karton aktywny</label>
          {selectedCarton && <><p>Wersja szkicu: {cartonVersion}; aktualnie odczytana: {selectedCarton.version}. Historia zachowuje dawne wymiary.</p><button type="button" className="button" onClick={() => { setCartonVersion(selectedCarton.version); setDraft({ code: selectedCarton.code, label: selectedCarton.label, enabled: selectedCarton.enabled, inner: { length: packingUnitText(selectedCarton.inner_dimensions.length_mm, 1), width: packingUnitText(selectedCarton.inner_dimensions.width_mm, 1), height: packingUnitText(selectedCarton.inner_dimensions.height_mm, 1) }, outer: { length: packingUnitText(selectedCarton.outer_dimensions.length_mm, 1), width: packingUnitText(selectedCarton.outer_dimensions.width_mm, 1), height: packingUnitText(selectedCarton.outer_dimensions.height_mm, 1) }, tare: packingUnitText(selectedCarton.tare_grams, 3) }); }}>Zastąp szkic aktualnym kartonem</button></>}
          <button type="button" className="button primary" onClick={saveCarton}>Zapisz karton</button>
        </fieldset>
      </div>
      <section className="packing-card"><h3>Polityka potwierdzania paczki</h3><p>Wymagany profil: <strong>{meta.policy.require_parcel_profile ? 'włączony' : 'wyłączony'}</strong> · wersja {meta.policy.version}</p><p>Włączenie wymaga dowodu stanowiska przy nowych przejściach do statusu „Spakowane”, również w automatyzacjach. Dawne spakowane zamówienia nie są zmieniane.</p>
        <label className="packing-check"><input type="checkbox" disabled={!write} checked={policyConsent} onChange={e => setPolicyConsent(e.target.checked)} />Potwierdzam zmianę polityki dla kolejnych operacji pakowania</label>
        <button type="button" className="button" disabled={!write || !policyConsent} onClick={() => io.mutate(prefix + '/policy', 'PATCH', { client_key: crypto.randomUUID(), version: meta.policy.version, require_parcel_profile: !meta.policy.require_parcel_profile }, 'Zmiana polityki', d => { setMeta(old => old ? { ...old, policy: d.policy } : old); saved('Polityka zapisana.'); })}>{meta.policy.require_parcel_profile ? 'Wyłącz wymaganie profilu' : 'Włącz wymaganie profilu'}</button>
      </section>
    </>}
  </section>;
}

function PhysicalTable({ rows, allocations = false }: { rows: (PhysicalItem | Allocation)[]; allocations?: boolean }) {
  return <div className="packing-table-wrap"><table className="packing-table">
    <thead><tr>{allocations ? <><th>Produkt</th><th>Lokalizacja</th><th>Ilość</th><th>Zeskanowano</th></> : <><th>Produkt zamówienia</th><th>Aktualny kod</th><th>Nazwa</th><th>Ilość</th><th>Zeskanowano</th><th>Dane referencyjne</th></>}</tr></thead>
    <tbody>{rows.map((row, index) => allocations ? <tr key={String(row.product_id) + ':' + String('location' in row ? row.location : '') + ':' + index}><td><code>{String(row.product_id ?? '')}</code></td><td>{String('location' in row ? row.location : '')}</td><td>{String(row.quantity ?? '')}</td><td>{String(row.scanned ?? '')}</td></tr> : <tr key={String(row.product_id) + ':' + index}><td>{String(row.order_sku ?? '')}</td><td>{String(row.current_sku ?? '—')}</td><td>{String(row.name ?? '')}</td><td>{String(row.quantity ?? '')}</td><td>{String(row.scanned ?? '')}</td><td>{row.reference ? <JsonDetails title="Aktualny katalog w chwili podglądu" value={row.reference} /> : 'Nie dołączono'}</td></tr>)}</tbody>
  </table></div>;
}
function projectionIssues(m: PackingMeasurements, provider: PackingParcelSeed['provider']): string[] {
  const out: string[] = [];
  if (provider === 'inpost_courier') {
    if (m.weight_grams > 25000) out.push('Masa przekracza 25 kg.');
    if ([m.length_mm, m.width_mm, m.height_mm].some(n => n > 1200)) out.push('Bok paczki przekracza 120 cm.');
    if (m.length_mm + m.width_mm + m.height_mm > 2200) out.push('Suma boków przekracza 220 cm.');
  } else {
    if (m.weight_grams < 10 || m.weight_grams > 31500 || m.weight_grams % 10 !== 0) out.push('DPD wymaga masy 0,01–31,5 kg z krokiem 0,01 kg. Pomiar nie będzie zaokrąglony.');
    for (const [label, n] of [['Długość', m.length_mm], ['Szerokość', m.width_mm], ['Wysokość', m.height_mm]] as const) {
      if (n < 10 || n > 1750 || n % 10 !== 0) out.push(label + ': DPD wymaga całkowitych cm w zakresie 1–175. Pomiar nie będzie zaokrąglony.');
    }
  }
  return out;
}
function FrozenPackingView({ kind, id, contextKey, readOnly, onParcelSeed, onDenied }: { kind: 'previews' | 'receipts'; id: string; contextKey: string; readOnly: boolean; onParcelSeed?: (seed: PackingParcelSeed) => void; onDenied?: () => void }) {
  const [detail, setDetail] = useState<FrozenDetail | null>(null), [items, setItems] = useState<PhysicalItem[]>([]), [allocations, setAllocations] = useState<Allocation[]>([]);
  const [itemsCursor, setItemsCursor] = useState<string | null>(null), [allocationCursor, setAllocationCursor] = useState<string | null>(null), [currentProfile, setCurrentProfile] = useState<Profile | null>(null);
  const purge = () => { setDetail(null); setItems([]); setAllocations([]); setItemsCursor(null); setAllocationCursor(null); setCurrentProfile(null); };
  const io = usePackingIO(contextKey + ':' + kind + ':' + id, readOnly, () => { purge(); onDenied?.(); });
  const path = prefix + '/' + kind + '/' + encodeURIComponent(id);
  async function load() {
    const d = await io.get<FrozenDetail>(path); setDetail(d);
    if (!d.available || !d.can_read) return;
    const i = await io.get<Page<PhysicalItem>>(path + '/items'), a = await io.get<Page<Allocation>>(path + '/allocations');
    setItems(i.data); setItemsCursor(i.meta.cursor); setAllocations(a.data); setAllocationCursor(a.meta.cursor);
    if (d.receipt) { const p = await io.get<Flags & { profile: Profile | null }>(prefix + '/orders/' + d.receipt.order_id + '/profile'); setCurrentProfile(p.profile); }
  }
  useEffect(() => { purge(); void io.read(load); }, [contextKey, kind, id, readOnly]);
  const head = detail?.receipt ?? detail?.preview;
  const receipt = detail?.receipt;
  const latest = receipt && currentProfile?.receipt_id === receipt.id && currentProfile.current;
  const summary = detail?.snapshot_summary;
  function handoff(provider: PackingParcelSeed['provider']) {
    if (!receipt || !latest || !detail?.can_write || io.locked || !onParcelSeed) return;
    void io.read(async () => {
      const p = await io.get<Flags & { profile: Profile | null }>(prefix + '/orders/' + receipt.order_id + '/profile'); setCurrentProfile(p.profile);
      if (!p.can_write || !p.profile?.current || p.profile.receipt_id !== receipt.id || p.profile.revision !== receipt.profile_revision || p.profile.scope_hash !== receipt.scope_hash) throw new Error('Dowód nie jest już aktualnym profilem paczki. Odczytaj historię i przygotuj nowy pomiar.');
      const issues = projectionIssues(receipt.measurements, provider);
      if (issues.length) throw new Error(issues.join(' '));
      onParcelSeed({ receipt_id: receipt.id, scope_hash: receipt.scope_hash, profile_revision: receipt.profile_revision, order_id: receipt.order_id, measurements: receipt.measurements, provider });
    });
  }
  return <section className="packing-card" aria-label={kind === 'previews' ? 'Zamrożony podgląd pakowania' : 'Dowód pakowania'}>
    <header className="packing-heading"><h3>{kind === 'previews' ? 'Podgląd całego zamówienia' : 'Dowód pakowania'}</h3><button type="button" className="button" disabled={io.busy} onClick={() => void io.read(load)}>Odśwież odczyt</button></header>
    <IONotice io={io} />
    {head && <>
      <p><strong><MeasurementsText value={head.measurements} /></strong></p>
      <p>Rodzaj: {head.kind === 'remeasure' ? 'Ponowny pomiar paczki' : 'Zakończenie pakowania'} · zapisano {date(head.created_at)}</p>
      {receipt && <p>Zamówienie {receipt.order_number} · {receipt.actor_name} · stanowisko {receipt.station_snapshot.code} — {receipt.station_snapshot.label} · rewizja profilu {receipt.profile_revision}. Wersja zamówienia {receipt.before_order_version} → {receipt.after_order_version}.</p>}
      {head.packaging.kind === 'custom' ? <p>Opakowanie niestandardowe: {head.packaging.label}. Uzasadnienie: {head.packaging.reason}</p> : <div>
        <p>Karton {head.packaging.carton_snapshot?.code} — {head.packaging.carton_snapshot?.label} · wersja {head.packaging.carton_version}</p>
        {head.packaging.carton_snapshot && <p>Zamrożone wymiary zewnętrzne: <DimensionsText value={head.packaging.carton_snapshot.outer_dimensions} />; wewnętrzne: <DimensionsText value={head.packaging.carton_snapshot.inner_dimensions} />; masa samego kartonu {packingUnitText(head.packaging.carton_snapshot.tare_grams, 3)} kg.</p>}
      </div>}
      {summary && <p>Pełny zakres: {String(summary.physical_count ?? '—')} fizycznych pozycji, {String(summary.allocation_count ?? '—')} przypisań lokalizacji; {String(summary.reference_count ?? '—')} pozycji z danymi referencyjnymi.</p>}
      <h4>Fizyczne pozycje — odczytano {items.length}</h4><PhysicalTable rows={items} />
      {itemsCursor && <button type="button" className="button" disabled={io.busy} onClick={() => void io.read(async () => { const d = await io.get<Page<PhysicalItem>>(path + '/items?cursor=' + encodeURIComponent(itemsCursor)); setItems(old => append(old, d.data)); setItemsCursor(d.meta.cursor); })}>Wczytaj kolejne pozycje (do 50)</button>}
      <h4>Przypisania lokalizacji — odczytano {allocations.length}</h4><PhysicalTable rows={allocations} allocations />
      {allocationCursor && <button type="button" className="button" disabled={io.busy} onClick={() => void io.read(async () => { const d = await io.get<Page<Allocation>>(path + '/allocations?cursor=' + encodeURIComponent(allocationCursor)); setAllocations(old => append(old, d.data)); setAllocationCursor(d.meta.cursor); })}>Wczytaj kolejne lokalizacje (do 50)</button>}
      <p className="packing-help">Każda strona jest częścią jednego zamrożonego zakresu. Zatwierdzenie obejmuje całe zamówienie, również kolejne strony.</p>
      <JsonDetails title="Szczegóły zatwierdzonego zakresu" value={summary} />
      <JsonDetails title="Identyfikatory dowodu" value={{ id: head.id, scope_hash: head.scope_hash }} />
      {receipt && <>
        {!latest && <p className="packing-warning">Ten dowód nie jest aktualnym profilem gotowym do przekazania do nadania.{currentProfile?.stale_reasons?.length ? ' ' + currentProfile.stale_reasons.join(' ') : ''}</p>}
        {(['inpost_courier', 'dpd'] as const).map(provider => { const errors = projectionIssues(receipt.measurements, provider); return <div key={provider} className="packing-handoff"><button type="button" className="button" disabled={!latest || !detail?.can_write || io.locked || !onParcelSeed || errors.length > 0} onClick={() => handoff(provider)}>{provider === 'dpd' ? 'Użyj w formularzu DPD' : 'Użyj w formularzu InPost Courier'}</button>{errors.map((e, i) => <p className="packing-warning" key={i}>{e}</p>)}</div>; })}
        <PackingPhotoPanel key={contextKey + ':' + receipt.id} contextKey={contextKey} receiptId={receipt.id} orderId={receipt.order_id} readOnly={readOnly || !detail?.can_write} />
        <p className="packing-help">Przekazanie otwiera osobny formularz nadania. Nie zleca kuriera. Powiązanie z gabarytem paczkomatu InPost pozostaje niedostępne.</p>
      </>}
    </>}
  </section>;
}

export function PackingWorkstationPanel({ contextKey, readOnly, externalWriteBlocked = false, orderId, refresh = 0, onOrder, onChanged, onParcelSeed }: PackingWorkstationPanelProps) {
  const [meta, setMeta] = useState<Metadata | null>(null), [stations, setStations] = useState<Station[]>([]), [cartons, setCartons] = useState<Carton[]>([]), [warehouses, setWarehouses] = useState<{ id: string; name: string }[]>([]);
  const [tab, setTab] = useState<'work' | 'history'>('work'), [warehouse, setWarehouse] = useState(''), [search, setSearch] = useState(''), [candidates, setCandidates] = useState<Candidate[]>([]), [candidateCursor, setCandidateCursor] = useState<string | null>(null);
  const [order, setOrder] = useState<OrderHead | null>(null), [candidate, setCandidate] = useState<Candidate | null>(null), [stationId, setStationId] = useState('');
  const [sessionId, setSessionId] = useState(''), [session, setSession] = useState<SessionDetail | null>(null), [physical, setPhysical] = useState<PhysicalItem[]>([]), [physicalCursor, setPhysicalCursor] = useState<string | null>(null);
  const [locations, setLocations] = useState<Allocation[]>([]), [locationsCursor, setLocationsCursor] = useState<string | null>(null), [locationProduct, setLocationProduct] = useState('');
  const [scanCode, setScanCode] = useState(''), [scanLocation, setScanLocation] = useState(''), [scanResult, setScanResult] = useState<ScanResult | null>(null), [reload, setReload] = useState(0);
  const [profile, setProfile] = useState<Profile | null>(null), [lastReceipt, setLastReceipt] = useState<Receipt | null>(null), [remeasuring, setRemeasuring] = useState(false);
  const [packagingId, setPackagingId] = useState(''), [customLabel, setCustomLabel] = useState(''), [customReason, setCustomReason] = useState(''), [remeasureReason, setRemeasureReason] = useState(''), [draft, setDraft] = useState<PackingMeasurementsDraft>(emptyMeasurements), [showErrors, setShowErrors] = useState(false), [includeEstimate, setIncludeEstimate] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null), [consent, setConsent] = useState(false), [finished, setFinished] = useState<Receipt | null>(null), [cancelConsent, setCancelConsent] = useState(false);
  const [history, setHistory] = useState<Receipt[]>([]), [historyCursor, setHistoryCursor] = useState<string | null>(null), [historySelected, setHistorySelected] = useState(''), [historyLoaded, setHistoryLoaded] = useState(false);
  const leases = useRef(new Map<string, string>());
  const handledRefresh = useRef({refresh,reload}), refreshEpoch = useRef(0);
  const [bootstrapped, setBootstrapped] = useState(false), [refreshFailed, setRefreshFailed] = useState(false);
  const queuedRefresh = handledRefresh.current.refresh !== refresh || handledRefresh.current.reload !== reload;
  function clearPreview() { setPreview(null); setConsent(false); }
  function clearWork() { setOrder(null); setCandidate(null); setSessionId(''); setSession(null); setPhysical([]); setPhysicalCursor(null); setLocations([]); setLocationsCursor(null); setLocationProduct(''); setScanCode(''); setScanLocation(''); setScanResult(null); setProfile(null); setLastReceipt(null); setRemeasuring(false); setPackagingId(''); setCustomLabel(''); setCustomReason(''); setRemeasureReason(''); setDraft(emptyMeasurements()); setShowErrors(false); setIncludeEstimate(false); clearPreview(); setFinished(null); setCancelConsent(false); }
  function purge() { clearWork(); leases.current.clear(); setMeta(null); setStations([]); setCartons([]); setWarehouses([]); setStationId(''); setWarehouse(''); setSearch(''); setCandidates([]); setCandidateCursor(null); setHistory([]); setHistoryCursor(null); setHistorySelected(''); setHistoryLoaded(false); }
  const io = usePackingIO(contextKey + ':' + (orderId ?? 'workspace'), readOnly, purge, status => { if ([409, 422].includes(status)) clearPreview(); }, contextKey, recoveredPacking, externalWriteBlocked, queuedRefresh || refreshFailed);
  function storeLease(id: string, token?: string) { rememberLease(contextKey, id, token); leases.current = readLeases(contextKey); }
  function applyFinished(d: { receipt: Receipt; result: { status: string; after_order_version: string; session_id: string | null } }) {
    if (d.result.session_id) { storeLease(d.result.session_id); setSessionId(d.result.session_id); setReload(v => v + 1); }
    setFinished(d.receipt); setLastReceipt(d.receipt); setConsent(false); setPreview(null); setRemeasuring(false);
    setOrder(old => ({ id: d.receipt.order_id, number: d.receipt.order_number, status: d.result.status, version: d.result.after_order_version, warehouse_id: old?.id === d.receipt.order_id ? old.warehouse_id : '' }));
    setProfile({ revision: d.receipt.profile_revision, receipt_id: d.receipt.id, scope_hash: d.receipt.scope_hash, current: true, stale_reasons: [] });
    setHistoryLoaded(false); onChanged?.();
  }
  function recoveredPacking(d: any, a: StoredAttempt) {
    if (d.session) {
      if (typeof a.body.lease_token === 'string') storeLease(d.session.id, a.body.lease_token);
      else if (a.path.endsWith('/cancel')) storeLease(d.session.id);
      setSessionId(d.session.id); clearPreview(); setCancelConsent(false); setReload(v => v + 1);
    } else if (d.operation) {
      if (a.headers['X-Packing-Lease']) storeLease(d.operation.session_id, a.headers['X-Packing-Lease']);
      setSessionId(d.operation.session_id); setScanResult(d.operation); setScanCode(''); clearPreview(); setReload(v => v + 1);
    } else if (d.preview) {
      setPreview(d.preview); setConsent(false); setDraft(measurementsDraft(d.preview.measurements));
      setRemeasuring(d.preview.kind === 'remeasure');
      setPackagingId(d.preview.packaging.kind === 'custom' ? 'custom' : d.preview.packaging.carton_id);
      if (d.preview.packaging.kind === 'custom') { setCustomLabel(d.preview.packaging.label); setCustomReason(d.preview.packaging.reason); }
      if (d.preview.session_id) {
        if (a.headers['X-Packing-Lease']) storeLease(d.preview.session_id, a.headers['X-Packing-Lease']);
        setSessionId(d.preview.session_id); setReload(v => v + 1);
      }
    } else if (d.receipt) applyFinished(d);
    else if (d.station) setStations(old => [d.station, ...old.filter(s => s.id !== d.station.id)]);
    else if (d.carton) setCartons(old => [d.carton, ...old.filter(c => c.id !== d.carton.id)]);
    else if (d.policy) setMeta(old => old ? { ...old, policy: d.policy } : old);
  }
  const station = stations.find(s => s.id === stationId), carton = cartons.find(c => c.id === packagingId);
  const write = !!meta?.available && !!meta.can_write && !io.locked;
  const leaseHeaders = (id = sessionId): Record<string, string> => { const token = leases.current.get(id); return token ? { 'X-Packing-Lease': token } : {}; };
  async function loadProfile(id: string) {
    const p = await io.get<Flags & { profile: Profile | null }>(prefix + '/orders/' + encodeURIComponent(id) + '/profile'); setProfile(p.profile);
    if (p.profile) { const d = await io.get<FrozenDetail>(prefix + '/receipts/' + p.profile.receipt_id); setLastReceipt(d.receipt ?? null); } else setLastReceipt(null);
  }
  async function loadSession(id: string) {
    const d = await io.get<SessionDetail>(prefix + '/sessions/' + encodeURIComponent(id), leaseHeaders(id));
    setSession(d); setSessionId(id); setOrder(d.order); setProfile(d.current_profile); setStationId(d.session.station_id);
    setLocations([]); setLocationsCursor(null); setLocationProduct('');
    const rows = await io.get<Page<PhysicalItem>>(prefix + '/sessions/' + id + '/items', leaseHeaders(id)); setPhysical(rows.data); setPhysicalCursor(rows.meta.cursor);
    return d;
  }
  async function openOrder(id: string, c?: Candidate, preserve = false) {
    if (!preserve) clearWork(); else clearPreview();
    const raw = await io.get<{ id: string; number: string; version: string | number; status: string; warehouse_id: string }>('/orders/' + encodeURIComponent(id));
    const o = { id: raw.id, number: raw.number, version: version(raw.version), status: raw.status, warehouse_id: raw.warehouse_id };
    setOrder(o); setWarehouse(o.warehouse_id); setCandidate(c ?? null);
    await loadProfile(id);
    let chosen = c;
    if (!chosen && o.status === 'picking') {
      const rows = await allPages<Candidate>(io, prefix + '/candidates?warehouse_id=' + o.warehouse_id + '&search=' + encodeURIComponent(o.number));
      chosen = rows.find(row => row.id === id); setCandidate(chosen ?? null);
    }
    if (chosen?.active_session_id) {
      const pending = io.pendingRequest();
      const restoredToken = pending ? pendingLease(pending) : undefined;
      if (!readOnly && pending && restoredToken && ((pending.path === prefix + '/sessions' && pending.body.order_id === id) || pending.path.startsWith(prefix + '/sessions/' + chosen.active_session_id + '/'))) storeLease(chosen.active_session_id, restoredToken);
      await loadSession(chosen.active_session_id);
    }
  }
  async function loadMetadata() {
    const m = await io.get<Metadata>(prefix); setMeta(m);
    if (!m.available || !m.can_read) return m;
    const ss = await allPages<Station>(io, prefix + '/stations'), cs = await allPages<Carton>(io, prefix + '/cartons');
    const ws = await io.get<{ data: { id: string; name: string }[] }>('/warehouses');
    setStations(ss); setCartons(cs); setWarehouses(ws.data); return m;
  }
  useEffect(() => {
    ++refreshEpoch.current;
    purge();
    setBootstrapped(false); setRefreshFailed(false); handledRefresh.current = {refresh,reload};
    if (!readOnly) { try { leases.current = readLeases(contextKey); } catch (e) { io.setError(detailMessage(e)); } }
    void io.read(async () => {
      const m = await loadMetadata(); if (!m.available || !m.can_read) {setBootstrapped(true);return;}
      const pending = io.pendingRequest();
      const requestOrder = typeof pending?.body.order_id === 'string' ? pending.body.order_id : undefined;
      if (orderId || requestOrder) await openOrder(orderId ?? requestOrder!);
      else if (pending) {
        const match = pending.path.match(/^\/packing\/sessions\/([a-f0-9-]{36})\//);
        if (match) {
          const token = pendingLease(pending);
          if (token && !readOnly) storeLease(match[1], token);
          const d = await loadSession(match[1]); await loadProfile(d.order.id);
        }
      }
      setBootstrapped(true);
    });
    return () => { ++refreshEpoch.current; };
  }, [contextKey, orderId, readOnly]);
  // Coalesce refreshes while a read/write owns the IO gate. Never replay a write.
  useEffect(() => {
    if (!bootstrapped || !meta?.available || io.pending || io.isReading() || !queuedRefresh) return;
    handledRefresh.current = {refresh,reload};
    const ownEpoch = refreshEpoch.current;
    void io.read(async () => {
      clearPreview();
      try {
        if (sessionId) { const d = await loadSession(sessionId); await loadProfile(d.order.id); }
        else if (orderId || order) await openOrder(orderId ?? order!.id, undefined, true);
        if (refreshEpoch.current === ownEpoch) setRefreshFailed(false);
      } catch (e) { if (refreshEpoch.current === ownEpoch) setRefreshFailed(true); throw e; }
    });
  }, [refresh,reload,bootstrapped,io.busy,io.pending,meta?.available]);
  async function findCandidates(more = false) {
    if (!warehouse) { io.setError('Wybierz magazyn.'); return; }
    const d = await io.get<Page<Candidate>>(prefix + '/candidates?warehouse_id=' + encodeURIComponent(warehouse) + (search ? '&search=' + encodeURIComponent(search) : '') + (more && candidateCursor ? '&cursor=' + encodeURIComponent(candidateCursor) : ''));
    setCandidates(old => more ? append(old, d.data) : d.data); setCandidateCursor(d.meta.cursor);
  }
  function start() {
    if (!write || !order || !station?.enabled) { io.setError('Wybierz aktywne stanowisko i zamówienie w kompletacji.'); return; }
    const token = crypto.randomUUID();
    io.mutate(prefix + '/sessions', 'POST', { client_key: crypto.randomUUID(), order_id: order.id, order_version: order.version, station_id: station.id, station_version: station.version, lease_token: token }, 'Rozpoczęcie sesji zamówienia ' + order.number, d => { storeLease(d.session.id, token); setSessionId(d.session.id); clearPreview(); setReload(v => v + 1); });
  }
  function leaseAction(kind: 'renew' | 'takeover' | 'cancel') {
    if (!session || !write) return;
    if (kind === 'takeover' && !station?.enabled) { io.setError('Wybierz aktywne stanowisko dla przejęcia sesji.'); return; }
    const token = kind === 'cancel' ? null : crypto.randomUUID();
    io.mutate(prefix + '/sessions/' + session.session.id + '/' + kind, 'POST', { client_key: crypto.randomUUID(), session_version: session.session.version, ...(token ? { lease_token: token } : {}), ...(kind === 'takeover' ? { station_id: station!.id, station_version: station!.version } : {}) }, kind === 'renew' ? 'Odnowienie dzierżawy' : kind === 'takeover' ? 'Przejęcie wygasłej sesji' : 'Anulowanie sesji', d => {
      storeLease(session.session.id, token ?? undefined);
      setSession(old => old ? { ...old, session: d.session } : old); clearPreview(); setCancelConsent(false); setReload(v => v + 1);
    }, kind === 'takeover' ? {} : leaseHeaders());
  }
  function scan(code = scanCode) {
    if (!session?.can_scan || !write || !code) return;
    io.mutate(prefix + '/sessions/' + session.session.id + '/scans', 'POST', { client_key: crypto.randomUUID(), session_version: session.session.version, order_version: session.order.version, code, ...(scanLocation ? { location: scanLocation } : {}) }, 'Skan jednej sztuki zamówienia ' + session.order.number, d => { setScanResult(d.operation); setScanCode(''); clearPreview(); setReload(v => v + 1); }, leaseHeaders());
  }
  function buildPreview() {
    if (!write || !order || !station?.enabled) { io.setError('Wybierz aktywne stanowisko.'); return; }
    setShowErrors(true); clearPreview();
    const check = validatePackingMeasurementsDraft(draft);
    if (!check.measurements) { io.setError('Popraw wszystkie pomiary gotowej paczki.'); return; }
    let packaging: Packaging;
    if (packagingId === 'custom') packaging = { kind: 'custom', label: customLabel, reason: customReason };
    else if (carton?.enabled) packaging = { kind: 'carton', carton_id: carton.id, carton_version: carton.version };
    else { io.setError('Wybierz karton lub jawne opakowanie niestandardowe.'); return; }
    const shared = { client_key: crypto.randomUUID(), station_version: station.version, packaging, measurements: check.measurements, include_product_estimate: includeEstimate };
    let body: Record<string, unknown>;
    if (remeasuring) {
      if (!profile) { io.setError('Brak profilu paczki do ponownego pomiaru.'); return; }
      body = { ...shared, kind: 'remeasure', order_id: order.id, order_version: order.version, profile_revision: profile.revision, replaces_receipt_id: profile.receipt_id, station_id: station.id, reason: remeasureReason };
    } else {
      if (!session || !leases.current.has(session.session.id)) { io.setError('Brak tokenu własnej sesji. Po wygaśnięciu użyj jawnego przejęcia.'); return; }
      body = { ...shared, kind: 'finish', session_id: session.session.id, session_version: session.session.version, order_version: session.order.version };
    }
    io.mutate(prefix + '/previews', 'POST', body, 'Podgląd pakowania zamówienia ' + order.number, d => { setPreview(d.preview); setConsent(false); }, remeasuring ? {} : leaseHeaders());
  }
  function finish() {
    if (!write || !preview?.ready || !consent) return;
    io.mutate(prefix + '/previews/' + preview.id + '/finish', 'POST', { client_key: crypto.randomUUID(), scope_hash: preview.scope_hash, confirmed: true, confirm_measured: true }, (preview.kind === 'remeasure' ? 'Zapis ponownego pomiaru ' : 'Zakończenie pakowania ') + (order?.number ?? preview.order_id), applyFinished, preview.kind === 'finish' ? leaseHeaders() : {});
  }
  async function loadHistory(more = false) {
    const path = prefix + '/receipts' + (orderId ? '?order_id=' + encodeURIComponent(orderId) : '') + (more && historyCursor ? (orderId ? '&' : '?') + 'cursor=' + encodeURIComponent(historyCursor) : '');
    const d = await io.get<Page<Receipt>>(path); setHistory(old => more ? append(old, d.data) : d.data); setHistoryCursor(d.meta.cursor); setHistoryLoaded(true);
  }
  return <section className="packing-workstation" aria-label="Stanowisko pakowania">
    <header className="packing-heading"><h2>Stanowisko pakowania</h2><div className="packing-actions"><button type="button" className="button" aria-pressed={tab === 'work'} disabled={io.busy || !!io.pending} onClick={() => setTab('work')}>Pakowanie</button><button type="button" className="button" aria-pressed={tab === 'history'} disabled={io.busy || !!io.pending} onClick={() => { setTab('history'); if (!historyLoaded) void io.read(() => loadHistory()); }}>Historia pakowania</button></div></header>
    <Availability meta={meta} readOnly={readOnly} /><IONotice io={io} />
    {meta?.available && <>
      {tab === 'history' ? <>
        <button type="button" className="button" disabled={io.busy} onClick={() => void io.read(() => loadHistory())}>Odśwież historię</button>
        {historyLoaded && !history.length && <p>Nie zapisano jeszcze dowodów pakowania w tym zakresie.</p>}
        <div className="packing-history">{history.map(r => <button type="button" key={r.id} className="packing-history-row" disabled={io.busy} onClick={() => setHistorySelected(r.id)}><strong>{r.order_number} · {r.kind === 'remeasure' ? 'Ponowny pomiar' : 'Spakowano'}</strong><MeasurementsText value={r.measurements} /><span>{r.actor_name} · {r.station_snapshot.label} · {date(r.created_at)} · rewizja {r.profile_revision}</span></button>)}</div>
        {historyCursor && <button type="button" className="button" disabled={io.busy} onClick={() => void io.read(() => loadHistory(true))}>Wczytaj kolejne dowody (do 50)</button>}
        {historySelected && <FrozenPackingView key={contextKey + historySelected} kind="receipts" id={historySelected} contextKey={contextKey} readOnly={readOnly} onParcelSeed={onParcelSeed} onDenied={io.denyAccess} />}
      </> : <>
        <p className="packing-help">Jedna paczka dla jednego zamówienia. Pomiary i zakończenie są lokalne; nadanie wymaga osobnego formularza i zgody.</p>
        <div className="packing-two">
          <label>Stanowisko<select value={stationId} disabled={io.locked || !meta.can_write || !!preview || (session?.session.state === 'active' && !session.can_takeover)} onChange={e => { setStationId(e.target.value); clearPreview(); }}><option value="">Wybierz stanowisko</option>{stations.filter(s => s.enabled || s.id === stationId).map(s => <option value={s.id} key={s.id}>{s.code} — {s.label}{s.enabled ? '' : ' (wyłączone)'}</option>)}</select></label>
          {!orderId && <label>Magazyn<select value={warehouse} disabled={io.locked} onChange={e => { setWarehouse(e.target.value); setCandidates([]); setCandidateCursor(null); clearWork(); }}><option value="">Wybierz magazyn</option>{warehouses.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}</select></label>}
        </div>
        {!orderId && <div className="packing-card"><label>Znajdź zamówienie<input value={search} disabled={io.locked} onChange={e => { setSearch(e.target.value); setCandidates([]); setCandidateCursor(null); }} /></label><button type="button" className="button" disabled={io.locked || !warehouse} onClick={() => void io.read(() => findCandidates())}>Szukaj zamówień do pakowania</button>
          {candidates.length === 0 && <p>Wybierz magazyn i wyszukaj własne zamówienia. Sesja rozpoczyna się dopiero po potwierdzeniu.</p>}
          {candidates.map(c => <div key={c.id} className="packing-candidate"><button type="button" className="button" disabled={io.locked} onClick={() => void io.read(() => openOrder(c.id, c))}>{c.number} · {statusNames[c.status] ?? c.status} · skany {c.scanned}/{c.quantity}</button>{c.blockers.length > 0 && <p>{c.blockers.join(' ')}</p>}{c.active_session_id && <small>Istnieje aktywna sesja — odczytaj jej właściciela i dostępne działania.</small>}</div>)}
          {candidateCursor && <button type="button" className="button" disabled={io.locked} onClick={() => void io.read(() => findCandidates(true))}>Wczytaj kolejne zamówienia (do 50)</button>}
        </div>}
        {order && <section className="packing-card"><header className="packing-heading"><h3>Zamówienie {order.number}</h3><div className="packing-actions">{onOrder && <button type="button" className="button" disabled={io.locked} onClick={() => onOrder(order.id)}>Otwórz kartę zamówienia</button>}<button type="button" className="button" disabled={io.busy || !!io.pending} onClick={() => void io.read(async () => { clearPreview(); await loadMetadata(); if (sessionId) { await loadSession(sessionId); await loadProfile(order.id); } else await openOrder(order.id, undefined, true); setRefreshFailed(false); })}>Odśwież stan zamówienia</button></div></header><p>{statusNames[order.status] ?? order.status} · wersja {order.version}</p>
          <PackingOrderFields key={contextKey + ':fields:' + order.id} contextKey={contextKey} orderId={order.id} refresh={refresh + reload} readFields={path => io.get<PackingOrderFieldDetail>(path)} />
          {candidate?.active_wave_id && <p className="packing-warning">Zamówienie jest w aktywnej partii kompletacji. Zakończ zbieranie w istniejącym ekranie; stanowisko nie zwolni partii automatycznie.</p>}
          {(!sessionId || session?.session.state === 'cancelled') && order.status === 'picking' && <button type="button" className="button primary" disabled={!write || !station?.enabled || !!candidate?.active_wave_id} onClick={start}>Rozpocznij pakowanie</button>}
          {!sessionId && order.status !== 'picking' && order.status !== 'packed' && <p>Rozpoczęcie sesji wymaga zamówienia w kompletacji. Zmień etap w karcie zamówienia zgodnie z jego płatnością.</p>}
          {profile && <div className={profile.current ? 'packing-success' : 'packing-warning'}><strong>{profile.current ? 'Aktualny profil gotowej paczki' : 'Profil paczki wymaga ponownego pomiaru'}</strong><p>Rewizja {profile.revision}{profile.stale_reasons.length ? ' · ' + profile.stale_reasons.join(' ') : ''}</p>{lastReceipt && <MeasurementsText value={lastReceipt.measurements} />}</div>}
          {order.status === 'packed' && !profile && <p className="packing-help">Brak dowodu stanowiska dla tego spakowanego zamówienia. Dotychczasowy formularz nadania bez powiązanego profilu pozostaje osobnym procesem.</p>}
          {order.status === 'packed' && profile && !remeasuring && <button type="button" className="button" disabled={!write} onClick={() => { setRemeasuring(true); clearPreview(); setDraft(emptyMeasurements()); setFinished(null); }}>Przygotuj ponowny pomiar paczki</button>}
        </section>}
        {session && <section className="packing-card"><h3>Sesja: {session.session.owner_name}</h3><p>Stan: {({ active: 'Aktywna', finished: 'Zakończona', cancelled: 'Anulowana' })[session.session.state]} · wersja {session.session.version} · dzierżawa do {date(session.session.expires_at)}.</p><p>Skany: {session.progress.scanned}/{session.progress.quantity}{session.progress.complete ? ' — kompletne' : ' — wymagają uzupełnienia'}.</p>
          {session.blockers.length > 0 && <p className="packing-warning">{session.blockers.join(' ')}</p>}
          {session.session.state === 'active' && <>
            {!leases.current.has(sessionId) && <p className="packing-warning">Ta przeglądarka nie ma tokenu tej sesji. Odczyt nie odnowi dzierżawy; po jej wygaśnięciu odśwież stan i jawnie przejmij sesję.</p>}
            <div className="packing-actions"><button type="button" className="button" disabled={!write || !leases.current.has(sessionId)} onClick={() => leaseAction('renew')}>Odnów dzierżawę na 15 minut</button><button type="button" className="button" disabled={!write || !session.can_takeover || !station?.enabled} onClick={() => leaseAction('takeover')}>Przejmij wygasłą sesję na wybrane stanowisko</button></div>
            <form onSubmit={e => { e.preventDefault(); scan(); }} className="packing-scan"><label>Kod produktu (SKU lub EAN)<input value={scanCode} disabled={!write || !session.can_scan} onChange={e => setScanCode(e.target.value)} /></label><label>Lokalizacja skanu<input value={scanLocation} disabled={!write || !session.can_scan} onChange={e => setScanLocation(e.target.value)} onKeyDown={onScanSuffix(submitForm)} /></label><button type="submit" className="button primary" disabled={!write || !session.can_scan || !scanCode}>Skanuj jedną sztukę</button></form>
            <BarcodeScanner label="Skanuj kod produktu aparatem" disabled={!write || !session.can_scan} onDetected={code => { setScanCode(code); scan(code); }} />
            {scanResult && <p className="packing-success" role="status">Przyjęto kod {scanResult.scanned_code}, lokalizacja {scanResult.location}: {scanResult.scanned_before} → {scanResult.scanned_after}. Wynik zapisany {date(scanResult.created_at)}.</p>}
            <details><summary>Anulowanie sesji</summary><p>Anulowanie zachowuje przyjęte skany i rezerwacje. Nie odpakowuje zakończonego zamówienia.</p><label className="packing-check"><input type="checkbox" disabled={!write} checked={cancelConsent} onChange={e => setCancelConsent(e.target.checked)} />Potwierdzam anulowanie tej sesji</label><button type="button" className="button" disabled={!write || !cancelConsent || (!meta.can_admin && !leases.current.has(sessionId))} onClick={() => leaseAction('cancel')}>Anuluj sesję</button></details>
          </>}
          <h4>Fizyczne produkty — odczytano {physical.length}</h4><PhysicalTable rows={physical} />
          {physicalCursor && <button type="button" className="button" disabled={io.busy} onClick={() => void io.read(async () => { const d = await io.get<Page<PhysicalItem>>(prefix + '/sessions/' + sessionId + '/items?cursor=' + encodeURIComponent(physicalCursor), leaseHeaders()); setPhysical(old => append(old, d.data)); setPhysicalCursor(d.meta.cursor); })}>Wczytaj kolejne produkty (do 50)</button>}
          <label>Produkt do odczytu lokalizacji<select value={locationProduct} disabled={io.busy} onChange={e => { setLocationProduct(e.target.value); setLocations([]); setLocationsCursor(null); }}><option value="">Wybierz fizyczny produkt</option>{physical.map(p => <option key={p.product_id} value={p.product_id}>{p.order_sku} — {p.name}</option>)}</select></label>
          <button type="button" className="button" disabled={io.busy || !locationProduct} onClick={() => void io.read(async () => { const d = await io.get<Page<Allocation>>(prefix + '/sessions/' + sessionId + '/allocations?product_id=' + locationProduct, leaseHeaders()); setLocations(d.data); setLocationsCursor(d.meta.cursor); })}>Odczytaj lokalizacje produktu</button>
          {locations.length > 0 && <PhysicalTable rows={locations} allocations />}{locationsCursor && <button type="button" className="button" disabled={io.busy} onClick={() => void io.read(async () => { const d = await io.get<Page<Allocation>>(prefix + '/sessions/' + sessionId + '/allocations?product_id=' + locationProduct + '&cursor=' + encodeURIComponent(locationsCursor), leaseHeaders()); setLocations(old => append(old, d.data)); setLocationsCursor(d.meta.cursor); })}>Wczytaj kolejne lokalizacje (do 50)</button>}
        </section>}
        {order && (remeasuring || session?.session.state === 'active') && <section className="packing-card"><h3>{remeasuring ? 'Ponowny pomiar gotowej paczki' : 'Opakowanie i rzeczywisty pomiar'}</h3>
          <label>Karton lub opakowanie<select value={packagingId} disabled={!write} onChange={e => { setPackagingId(e.target.value); clearPreview(); }}><option value="">Wybierz opakowanie</option><option value="custom">Opakowanie niestandardowe</option>{cartons.filter(c => c.enabled || c.id === packagingId).map(c => <option key={c.id} value={c.id}>{c.code} — {c.label}{c.enabled ? '' : ' (wyłączony)'}</option>)}</select></label>
          {packagingId === 'custom' && <div className="packing-two"><label>Nazwa opakowania niestandardowego<input value={customLabel} disabled={!write} onChange={e => { setCustomLabel(e.target.value); clearPreview(); }} /></label><label>Uzasadnienie opakowania niestandardowego<textarea value={customReason} disabled={!write} onChange={e => { setCustomReason(e.target.value); clearPreview(); }} /></label></div>}
          {remeasuring && <><label>Uzasadnienie ponownego pomiaru<textarea value={remeasureReason} disabled={!write} onChange={e => { setRemeasureReason(e.target.value); clearPreview(); }} /></label><p>Status pozostaje „Spakowane”. Zapis powstanie jako nowy dowód; dawny nie zostanie nadpisany. Istniejąca lub niepewna przesyłka może zablokować zmianę.</p>{lastReceipt && <button type="button" className="button" disabled={!write} onClick={() => { setDraft(measurementsDraft(lastReceipt.measurements)); clearPreview(); }}>Użyj ostatniego pomiaru jako szkicu</button>}</>}
          <PackingMeasurementsForm draft={draft} carton={carton ? cartonSeed(carton) : null} disabled={!write} readOnly={readOnly || !!meta.read_only} showErrors={showErrors} onChange={next => { setDraft(next); clearPreview(); }} />
          <label className="packing-check"><input type="checkbox" checked={includeEstimate} disabled={!write} onChange={e => { setIncludeEstimate(e.target.checked); clearPreview(); }} />Dołącz referencyjne dane produktów z aktualnego katalogu (wymaga products:read)</label>
          <p className="packing-help">Masa kartonu i katalogu nie są automatycznie dodawane do pomiaru. Nie wyliczamy ułożenia produktów ani dopasowania 3D.</p>
          <button type="button" className="button primary" disabled={!write || (!remeasuring && !leases.current.has(sessionId))} onClick={buildPreview}>Zapisz podgląd całego zakresu</button>
        </section>}
        {preview && <><FrozenPackingView key={preview.id} kind="previews" id={preview.id} contextKey={contextKey} readOnly={readOnly} onDenied={io.denyAccess} /><section className="packing-card"><h3>Zatwierdzenie podglądu</h3><p>Podgląd ważny do {date(preview.expires_at)}. {preview.kind === 'finish' ? 'Zakończenie zapisze dowód i zmieni status na „Spakowane”. Zapasy nie zostaną ponownie rozchodowane.' : 'Nowy dowód zastąpi wskaźnik profilu; status i wersja zamówienia pozostaną bez zmiany.'}</p>
          {!preview.ready && <p className="packing-warning">Podgląd nie jest gotowy: {preview.issues.map(issue => issue === 'ORDER_FIELDS_REQUIRED' ? 'Uzupełnij wymagane pola zamówienia przed zakończeniem pakowania.' : issue).join(' ')}</p>}
          {preview.automations_warning?.may_enqueue && <p className="packing-warning">Przejście do „Spakowane” może uruchomić wcześniej zatwierdzone automatyzacje order.packed. Ten formularz nie potwierdza dostarczenia email/SMS ani skutku u przewoźnika.</p>}
          {preview.automations_warning?.local_financial_fence_exit && <p className="packing-warning">Zmiana etapu może zakończyć bieżące ograniczenie lokalnych reguł finansowych; obowiązują wcześniej skonfigurowane procesy.</p>}
          <label className="packing-check"><input type="checkbox" disabled={!write || !preview.ready} checked={consent} onChange={e => setConsent(e.target.checked)} />Potwierdzam rzeczywisty pomiar gotowej paczki i cały zakres tego podglądu</label><button type="button" className="button primary" disabled={!write || !preview.ready || !consent} onClick={finish}>{preview.kind === 'remeasure' ? 'Zapisz nowy dowód pomiaru' : 'Zakończ pakowanie'}</button>
        </section></>}
        {finished && <><p className="packing-success" role="status">{finished.kind === 'remeasure' ? 'Zapisano nowy pomiar' : 'Spakowano zamówienie'} {finished.order_number} · rewizja {finished.profile_revision}.</p><FrozenPackingView key={finished.id} kind="receipts" id={finished.id} contextKey={contextKey} readOnly={readOnly} onParcelSeed={onParcelSeed} onDenied={io.denyAccess} /></>}
        {!finished && lastReceipt && order?.status === 'packed' && !remeasuring && <FrozenPackingView key={lastReceipt.id} kind="receipts" id={lastReceipt.id} contextKey={contextKey} readOnly={readOnly} onParcelSeed={onParcelSeed} onDenied={io.denyAccess} />}
      </>}
    </>}
  </section>;
}
