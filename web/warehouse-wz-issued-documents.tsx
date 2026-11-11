import { useEffect, useRef, useState } from 'react';
import './warehouse-wz-issued-documents.css';

/** View models only. The coordinator supplies authenticated GET adapters;
 * no issuer, configuration writer or HTTP route is assumed by this panel. */
export type WzIssuedAccess = { context_key: string; available: boolean; read_only: boolean; current_role: 'admin' | 'operator' | 'viewer'; can_read: boolean; can_read_value: boolean };
export type WzIssuedWarehouse = { id: string; name: string; code: string };
export type WzIssuedSource = { kind: 'demo' | 'shipping_plan' | 'parcel'; order_id: string; shipment_id: string; plan_id?: string; parcel_index?: number; dispatch_id?: string };
export type WzIssuedSummary = { physical_quantity: number; known_value_minor?: string; unknown_quantity?: number; currency?: string; exponent?: number };
type WzIssuedLineBase = { item_id: string; product_id: string; name: string; sku: string; original_quantity: number; line_total?: number; vat?: number; currency?: string; components: { product_id: string; quantity: number }[]; allocations: { physical_id: string; product_id: string; warehouse_id: string; quantity: number }[] };
export type WzIssuedCommercialLine = WzIssuedLineBase & ({ lineage_kind?: undefined; quantity: number; component_quantities?: never } | { lineage_kind: 'physical_item_components_v1'; quantity?: never; component_quantities: { product_id: string; quantity: number }[] });
export type WzIssuedDocument = { id: string; kind: 'WZ'; receipt_id: string; number: string; series_id: string; year: number; sequence: string; warehouse: WzIssuedWarehouse; source: WzIssuedSource; created_at: string; row_count: number; summary: WzIssuedSummary; commercial_lines: WzIssuedCommercialLine[]; value_available: boolean };
export type WzIssuedRow = { ordinal: number; product_id: string; sku: string; name: string; quantity: number; location: string; stock_movement_id: string; location_movement_id: string; operation_id: string | null; issue_fragment_id: string | null; layer_movement_id: string | null; layer_id: string | null; lot_id: string | null; unit_cost_minor?: string | null; value_minor?: string | null; currency?: string; exponent?: number };
export type WzIssuedOptions = { access: WzIssuedAccess; warehouses: WzIssuedWarehouse[]; limits: { page: 50; rows: number; file_bytes: number } };
export type WzIssuedFilters = { warehouse_id: string; order_id: string };
export type WzIssuedPage = { access: WzIssuedAccess; data: WzIssuedDocument[]; meta: { cursor: string | null; limit: 50 } };
export type WzIssuedDetail = { access: WzIssuedAccess; document: WzIssuedDocument; rows: WzIssuedRow[]; snapshot_at: string };
export type WzIssuedExport = { access: WzIssuedAccess; document: WzIssuedDocument; format: 'csv' | 'xml'; values_included: boolean; row_count: number; filename: string; content_type: string; content: string; snapshot_at: string };
export type WzIssuedReader = {
  /** Must verify actual /auth/me identity and fresh server read/value flags.
   * context_key is derived from that identity, never echoed from the argument. */
  access: (contextKey: string) => Promise<WzIssuedAccess>;
  options: (contextKey: string) => Promise<WzIssuedOptions>;
  list: (filters: WzIssuedFilters, cursor: string | null, contextKey: string) => Promise<WzIssuedPage>;
  detail: (documentId: string, contextKey: string) => Promise<WzIssuedDetail>;
  exportDocument: (documentId: string, format: 'csv' | 'xml', includeValues: boolean, contextKey: string) => Promise<WzIssuedExport>;
};
export type WarehouseWzIssuedDocumentsProps = { contextKey: string; available: boolean; readOnly: boolean; refresh: number; reader: WzIssuedReader; onOpenOrder?: (orderId: string) => void; onOpenShipment?: (orderId: string, shipmentId: string) => void };

const uuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v);
const natural = (v: unknown): v is string => typeof v === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(v) && BigInt(v) <= 9223372036854775807n;
const quantity = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const timestamp = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(v) && Number.isFinite(Date.parse(v));
const stamp = (v: string) => v.slice(0, 19) + '.' + (v.match(/\.(\d+)(?:Z|\+00:00)$/)?.[1] ?? '').padEnd(6, '0') + 'Z';
const moneyKeys = new Set(['unit_cost_minor', 'value_minor', 'known_value_minor', 'unknown_quantity', 'currency', 'exponent', 'rows_sha256', 'line_total', 'vat']);
function redact<T>(v: T): T {
  if (Array.isArray(v)) return v.map(x => redact(x)) as T;
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([k]) => !moneyKeys.has(k)).map(([k, x]) => [k, k === 'value_available' ? false : redact(x)])) as T;
  return v;
}
function canonical(v: unknown): string { if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']'; if (v && typeof v === 'object') return '{' + Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => JSON.stringify(k) + ':' + canonical(x)).join(',') + '}'; return JSON.stringify(v) ?? 'undefined'; }
function checkWarehouse(w: WzIssuedWarehouse) { if (!w || !uuid(w.id) || typeof w.name !== 'string' || typeof w.code !== 'string') throw Error('Niepełny zapis magazynu dokumentu WZ.'); }
function checkHead(d: WzIssuedDocument) {
  if (!d || !uuid(d.id) || d.kind !== 'WZ' || !uuid(d.receipt_id) || !uuid(d.series_id) || typeof d.number !== 'string' || !d.number || !Number.isInteger(d.year) || d.year < 1900 || d.year > 9999 || !natural(d.sequence) || d.sequence === '0' || !timestamp(d.created_at) || !quantity(d.row_count) || d.row_count < 1 || d.row_count > 10000 || typeof d.value_available !== 'boolean') throw Error('Niepełny nagłówek zapisanego WZ.');
  checkWarehouse(d.warehouse); const s = d.source;
  if (!s || !['demo', 'shipping_plan', 'parcel'].includes(s.kind) || !uuid(s.order_id) || !uuid(s.shipment_id) || (s.kind !== 'demo' && !uuid(s.plan_id)) || (s.kind === 'parcel' && (!quantity(s.parcel_index) || !uuid(s.dispatch_id))) || (s.kind === 'demo' && (s.plan_id !== undefined || s.parcel_index !== undefined || s.dispatch_id !== undefined)) || (s.kind === 'shipping_plan' && (s.parcel_index !== undefined || s.dispatch_id !== undefined))) throw Error('Brak rzeczywistego źródła wydania WZ.');
  const t = d.summary;
  if (!t || !quantity(t.physical_quantity) || t.physical_quantity < 1) throw Error('Brak pełnej fizycznej ilości dokumentu WZ.');
  const values = ['known_value_minor', 'unknown_quantity', 'currency', 'exponent'] as const;
  if (values.some(k => t[k] !== undefined) && (!natural(t.known_value_minor) || !quantity(t.unknown_quantity) || t.unknown_quantity > t.physical_quantity || typeof t.currency !== 'string' || !/^[A-Z]{3}$/.test(t.currency) || !Number.isInteger(t.exponent) || t.exponent! < 0 || t.exponent! > 6)) throw Error('Niepełna historyczna wycena WZ.');
  if (d.value_available !== values.every(k => t[k] !== undefined)) throw Error('Dostępność wyceny WZ nie odpowiada zapisanym polom.');
  if (!Array.isArray(d.commercial_lines) || !d.commercial_lines.length || d.commercial_lines.length > 10000 || new Set(d.commercial_lines.map(l => l.item_id)).size !== d.commercial_lines.length) throw Error('Niepełne oryginalne pozycje zamówienia WZ.');
  for (const l of d.commercial_lines) {
    const physical = l.lineage_kind === 'physical_item_components_v1';
    if (!uuid(l.item_id) || !uuid(l.product_id) || typeof l.name !== 'string' || typeof l.sku !== 'string' || !quantity(l.original_quantity) || l.original_quantity < 1 || !Array.isArray(l.components) || !l.components.length || !Array.isArray(l.allocations) || !l.allocations.length || new Set(l.components.map(c => c.product_id)).size !== l.components.length) throw Error('Niepełna historyczna pozycja WZ.');
    if (physical) {
      if (Object.hasOwn(l, 'quantity') || !Array.isArray(l.component_quantities) || !l.component_quantities.length || l.component_quantities.length > 500 || new Set(l.component_quantities.map(c => c.product_id)).size !== l.component_quantities.length) throw Error('Niepełna jawna mapa składników WZ.');
    } else if (l.lineage_kind !== undefined || Object.hasOwn(l, 'component_quantities') || !quantity(l.quantity) || l.quantity < 1 || l.quantity > l.original_quantity) throw Error('Niepełna historyczna pozycja handlowa WZ.');
    if (['line_total','vat','currency'].some(k => Object.hasOwn(l,k)) && (!quantity(l.line_total) || !quantity(l.vat) || typeof l.currency !== 'string' || !/^[A-Z]{3}$/.test(l.currency))) throw Error('Niepełne historyczne wartości pozycji handlowej WZ.');
    const sums = new Map<string, bigint>();
    for (const c of l.components) { if (!uuid(c.product_id) || !quantity(c.quantity) || c.quantity < 1) throw Error('Niepełna zapisana receptura WZ.'); sums.set(c.product_id, 0n); }
    const unique = new Set<string>();
    for (const a of l.allocations) { const key = a.physical_id + ':' + a.product_id + ':' + a.warehouse_id; if (!uuid(a.physical_id) || !uuid(a.product_id) || !uuid(a.warehouse_id) || !quantity(a.quantity) || a.quantity < 1 || !sums.has(a.product_id) || unique.has(key)) throw Error('Niepełne przypisanie wydania do oryginalnej pozycji WZ.'); unique.add(key); sums.set(a.product_id, sums.get(a.product_id)! + BigInt(a.quantity)); }
    if (l.lineage_kind === 'physical_item_components_v1') {
      const expected = new Map<string, bigint>();
      for (const c of l.component_quantities) { const source = l.components.find(x => x.product_id === c.product_id); if (!source || !uuid(c.product_id) || !quantity(c.quantity) || c.quantity < 1 || c.quantity > 1000000000 || BigInt(c.quantity) > BigInt(l.original_quantity) * BigInt(source.quantity)) throw Error('Przypisanie przekracza historyczne składniki pozycji WZ.'); expected.set(c.product_id, BigInt(c.quantity)); }
      for (const [product, issued] of sums) if (issued !== (expected.get(product) ?? 0n)) throw Error('Wydane fragmenty nie pokrywają jawnej mapy składników WZ.');
    } else for (const c of l.components) if (sums.get(c.product_id) !== BigInt(l.quantity) * BigInt(c.quantity)) throw Error('Wydane fragmenty nie pokrywają zapisanej receptury pozycji WZ.');
  }
}
function checkDetail(d: WzIssuedDetail, cap: number) {
  checkHead(d.document);
  if (!timestamp(d.snapshot_at) || !Array.isArray(d.rows) || d.rows.length !== d.document.row_count || d.rows.length > cap) throw Error('Nie odczytano wszystkich zapisanych pozycji WZ.');
  let physical = 0n, known = 0n, unknown = 0n;
  const fragments = new Set<string>(), movements = new Set<string>();
  for (const [i, r] of d.rows.entries()) {
    if (r.ordinal !== i || !uuid(r.product_id) || typeof r.sku !== 'string' || typeof r.name !== 'string' || !quantity(r.quantity) || r.quantity < 1 || typeof r.location !== 'string' || !r.location || !uuid(r.stock_movement_id) || !uuid(r.location_movement_id)) throw Error('Niepełne pozycje lub źródłowe ruchy WZ.');
    const wmsIds = [r.operation_id, r.issue_fragment_id, r.layer_movement_id, r.layer_id, r.lot_id];
    if (!wmsIds.every(v => v === null) && !wmsIds.every(uuid)) throw Error('Niepełne źródło fragmentu WMS w WZ.');
    if (r.issue_fragment_id !== null) { if (fragments.has(r.issue_fragment_id) || movements.has(r.layer_movement_id!)) throw Error('Powtórzony fragment źródłowego wydania WZ.'); fragments.add(r.issue_fragment_id); movements.add(r.layer_movement_id!); }
    const hasValue = ['unit_cost_minor', 'value_minor', 'currency', 'exponent'].some(k => Object.hasOwn(r, k));
    if (d.document.value_available) {
      const s = d.document.summary;
      if (!hasValue || r.operation_id === null || r.currency !== s.currency || r.exponent !== s.exponent || r.unit_cost_minor === undefined || r.value_minor === undefined || (r.unit_cost_minor === null) !== (r.value_minor === null) || (r.unit_cost_minor !== null && (!natural(r.unit_cost_minor) || !natural(r.value_minor) || BigInt(r.value_minor) !== BigInt(r.unit_cost_minor) * BigInt(r.quantity)))) throw Error('Wycena nie odpowiada zapisanym fragmentom WZ.');
      if (r.value_minor === null) unknown += BigInt(r.quantity); else known += BigInt(r.value_minor);
    } else if (hasValue) throw Error('Wycena WZ nie jest dostępna w tym odczycie.');
    physical += BigInt(r.quantity);
  }
  const t = d.document.summary;
  if (physical !== BigInt(t.physical_quantity) || (d.document.value_available && (known !== BigInt(t.known_value_minor!) || unknown !== BigInt(t.unknown_quantity!)))) throw Error('Pełne pozycje WZ nie odpowiadają podsumowaniu.');
  const remaining = new Map(d.rows.map(r => [r.issue_fragment_id ?? r.location_movement_id, { product_id: r.product_id, quantity: BigInt(r.quantity) }]));
  if (remaining.size !== d.rows.length) throw Error('Powtórzona fizyczna tożsamość pozycji WZ.');
  for (const l of d.document.commercial_lines) for (const a of l.allocations) if (a.warehouse_id === d.document.warehouse.id) { const r = remaining.get(a.physical_id); if (!r || r.product_id !== a.product_id || r.quantity < BigInt(a.quantity)) throw Error('Przypisanie oryginalnej pozycji wskazuje inne wydanie WZ.'); r.quantity -= BigInt(a.quantity); }
  if ([...remaining.values()].some(r => r.quantity !== 0n)) throw Error('Oryginalne pozycje nie pokrywają całego wydania z magazynu WZ.');
}
function commercialAmount(l: WzIssuedCommercialLine) {
  if (l.line_total === undefined || l.currency === undefined) return 'Wartość pozycji niedostępna';
  const exponent = new Intl.NumberFormat('pl-PL', { style: 'currency', currency: l.currency }).resolvedOptions().maximumFractionDigits;
  return amount(String(l.line_total), { physical_quantity: 0, currency: l.currency, exponent });
}
function amount(v: string | null | undefined, s: WzIssuedSummary) {
  if (v === undefined || s.currency === undefined || s.exponent === undefined) return 'Wycena niedostępna';
  if (v === null) return 'Koszt nieznany';
  const n = BigInt(v), scale = 10n ** BigInt(s.exponent);
  return `${n / scale}${s.exponent ? ',' + (n % scale).toString().padStart(s.exponent, '0') : ''} ${s.currency}`;
}
class StaleRead extends Error {}
const sourceNames = { demo: 'Wydanie całego zamówienia', shipping_plan: 'Wydanie przez plan wysyłki', parcel: 'Wydanie osobnej paczki' };
const emptyFilters = (): WzIssuedFilters => ({ warehouse_id: '', order_id: '' });

export function WarehouseWzIssuedDocuments(props: WarehouseWzIssuedDocumentsProps) {
  const latest = useRef(props); latest.current = props;
  const alive = useRef(false), generation = useRef(0), cursors = useRef(new Set<string>());
  const [owner, setOwner] = useState(props.contextKey), [flags, setFlags] = useState<WzIssuedAccess | null>(null), [limits, setLimits] = useState<WzIssuedOptions['limits'] | null>(null), [warehouses, setWarehouses] = useState<WzIssuedWarehouse[]>([]), [draft, setDraft] = useState(emptyFilters), [filters, setFilters] = useState(emptyFilters), [heads, setHeads] = useState<WzIssuedDocument[]>([]), [cursor, setCursor] = useState<string | null>(null), [detail, setDetail] = useState<WzIssuedDetail | null>(null), [busy, setBusy] = useState(false), [loaded, setLoaded] = useState(false), [error, setError] = useState(''), [page, setPage] = useState(0), [format, setFormat] = useState<'csv' | 'xml'>('csv'), [includeValues, setIncludeValues] = useState(false), [downloaded, setDownloaded] = useState('');
  const current = (g: number, ctx: string, reader: WzIssuedReader) => alive.current && generation.current === g && latest.current.contextKey === ctx && latest.current.available && latest.current.reader === reader && ctx.split(':')[3] === String(latest.current.readOnly);
  function clear() { setFlags(null); setLimits(null); setWarehouses([]); setHeads([]); setCursor(null); setDetail(null); setIncludeValues(false); setDownloaded(''); setLoaded(false); cursors.current.clear(); }
  function checkAccess(a: WzIssuedAccess, ctx: string) {
    const p = ctx.split(':');
    if (p.length !== 4 || !uuid(p[0]) || !uuid(p[1]) || !['admin', 'operator', 'viewer'].includes(p[2]) || !['true', 'false'].includes(p[3]) || !a || a.context_key !== ctx || a.current_role !== p[2] || a.read_only !== latest.current.readOnly || ['available', 'read_only', 'can_read', 'can_read_value'].some(k => typeof a[k as keyof WzIssuedAccess] !== 'boolean')) throw Error('Zmieniła się firma, użytkownik lub dostęp do WZ.');
    if (!a.available || !a.can_read) throw Error('Brak aktualnego dostępu do zapisanych WZ.');
    setFlags(a); if (!a.can_read_value) { setHeads(v => redact(v)); setDetail(v => v ? redact(v) : null); setIncludeValues(false); setDownloaded(''); }
  }
  async function access(g: number, ctx: string, reader: WzIssuedReader) { const a = await reader.access(ctx); if (!current(g, ctx, reader)) throw new StaleRead(); checkAccess(a, ctx); return a; }
  function accept(a: WzIssuedAccess, g: number, ctx: string, reader: WzIssuedReader) { if (!current(g, ctx, reader)) throw new StaleRead(); checkAccess(a, ctx); return a; }
  async function read(work: (g: number, ctx: string, reader: WzIssuedReader, initial: WzIssuedAccess) => Promise<void>) {
    const g = ++generation.current, ctx = latest.current.contextKey, reader = latest.current.reader; setBusy(true); setError(''); setDownloaded('');
    try { if (!latest.current.available) throw Error('Odczyt zapisanych automatycznych WZ nie jest dostępny.'); await work(g, ctx, reader, await access(g, ctx, reader)); }
    catch (err) { if (current(g, ctx, reader)) { clear(); setError(err instanceof Error ? err.message : 'Nie udało się odczytać WZ.'); } }
    finally { if (current(g, ctx, reader)) setBusy(false); }
  }
  async function list(f: WzIssuedFilters, more = false) {
    const prior = more ? heads : [], oldCursor = more ? cursor : null;
    if (!more) { setHeads([]); setDetail(null); setCursor(null); setLoaded(false); cursors.current.clear(); }
    await read(async (g, ctx, reader, initial) => {
      if ((f.warehouse_id && !uuid(f.warehouse_id)) || (f.order_id && !uuid(f.order_id))) throw Error('Wybierz magazyn lub podaj pełny identyfikator zamówienia.');
      let cap = limits, optionValues = initial.can_read_value;
      if (!more) {
        const o = await reader.options(ctx); accept(o.access, g, ctx, reader);
        if (!Array.isArray(o.warehouses) || o.warehouses.length > 200 || new Set(o.warehouses.map(w => w.id)).size !== o.warehouses.length || !o.limits || o.limits.page !== 50 || !quantity(o.limits.rows) || o.limits.rows < 1 || o.limits.rows > 10000 || !quantity(o.limits.file_bytes) || o.limits.file_bytes < 1 || o.limits.file_bytes > 8 * 1024 * 1024) throw Error('Niepełne opcje odczytu WZ.');
        o.warehouses.forEach(checkWarehouse); setWarehouses(o.warehouses); setLimits(o.limits); cap = o.limits; optionValues &&= o.access.can_read_value;
      }
      if (!cap || (more && !oldCursor)) throw Error('Brak pełnego zakresu następnej strony WZ.');
      const d = await reader.list(f, oldCursor, ctx); accept(d.access, g, ctx, reader);
      if (!Array.isArray(d.data) || d.data.length > 50 || d.meta?.limit !== 50 || (d.meta.cursor !== null && (typeof d.meta.cursor !== 'string' || !d.meta.cursor || d.meta.cursor.length > 4096 || cursors.current.has(d.meta.cursor))) || (d.meta.cursor !== null && !d.data.length)) throw Error('Niepełna strona lub powtórzony kursor WZ.');
      const values = optionValues && d.access.can_read_value, rows = values ? d.data : redact(d.data);
      rows.forEach(checkHead); const all = [...prior, ...rows];
      if (new Set(all.map(h => h.id)).size !== all.length || rows.some(h => (f.warehouse_id && h.warehouse.id !== f.warehouse_id) || (f.order_id && h.source.order_id !== f.order_id))) throw Error('Dokumenty WZ powtarzają się lub nie odpowiadają filtrom.');
      for (let i = 1; i < all.length; i++) { const a = all[i - 1], b = all[i]; if (stamp(b.created_at) > stamp(a.created_at) || (stamp(b.created_at) === stamp(a.created_at) && b.id >= a.id)) throw Error('Nieprawidłowa kolejność zapisanych WZ.'); }
      const final = await access(g, ctx, reader); if (d.meta.cursor) cursors.current.add(d.meta.cursor); setHeads(values && final.can_read_value ? all : redact(all)); setCursor(d.meta.cursor); setLoaded(true);
    });
  }
  async function open(h: WzIssuedDocument) {
    setDetail(null); setPage(0); setIncludeValues(false);
    await read(async (g, ctx, reader, initial) => {
      const d = await reader.detail(h.id, ctx); accept(d.access, g, ctx, reader); const final = await access(g, ctx, reader);
      const value = initial.can_read_value && d.access.can_read_value && final.can_read_value, shown = value ? d : redact(d);
      if (!limits) throw Error('Brak limitu pełnego odczytu WZ.'); checkDetail(shown, limits.rows);
      if (canonical(redact(shown.document)) !== canonical(redact(h))) throw Error('Szczegóły wskazują inny zapisany dokument WZ.');
      if (value && h.value_available && canonical(shown.document) !== canonical(h)) throw Error('Szczegóły wskazują inną zapisaną wycenę WZ.');
      setDetail(shown);
    });
  }
  async function download() {
    if (!detail || !limits) return; const frozen = detail.document, chosenFormat = format, chosenValues = includeValues, cap = limits.file_bytes;
    await read(async (g, ctx, reader, initial) => {
      if (chosenValues && !initial.can_read_value) throw Error('Odebrano prawo do wyceny WZ.');
      const d = await reader.exportDocument(frozen.id, chosenFormat, chosenValues, ctx); accept(d.access, g, ctx, reader); checkHead(d.document);
      if (canonical(redact(d.document)) !== canonical(redact(frozen)) || d.format !== chosenFormat || d.values_included !== (chosenValues && frozen.value_available) || d.row_count !== frozen.row_count || !timestamp(d.snapshot_at) || typeof d.content !== 'string' || new TextEncoder().encode(d.content).length > cap || d.content_type !== (chosenFormat === 'csv' ? 'text/csv; charset=utf-8' : 'application/xml; charset=utf-8') || typeof d.filename !== 'string' || !/^[^/\\\u0000-\u001f\u007f]{1,200}$/.test(d.filename) || !d.filename.endsWith('.' + chosenFormat)) throw Error('Eksport nie odpowiada pełnemu zapisanemu WZ.');
      if (d.values_included && (!d.access.can_read_value || canonical(d.document) !== canonical(frozen))) throw Error('Eksport ma inną historyczną wycenę WZ.');
      if (!chosenValues && (d.document.value_available || d.document.commercial_lines.some(l => ['line_total','vat','currency'].some(k => Object.hasOwn(l,k))))) throw Error('Eksport ilościowy zawiera niezamówioną wycenę.');
      const final = await access(g, ctx, reader); if (chosenValues && !final.can_read_value) throw Error('Odebrano wycenę przed pobraniem WZ.'); if (!current(g, ctx, reader)) throw new StaleRead();
      const url = URL.createObjectURL(new Blob([d.content], { type: d.content_type }));
      try { const anchor = document.createElement('a'); anchor.href = url; anchor.download = d.filename; document.body.append(anchor); anchor.click(); anchor.remove(); } finally { URL.revokeObjectURL(url); }
      setDownloaded('Przekazano plik do przeglądarki: ' + d.filename + '. Sprawdź zapis w pobranych plikach.');
    });
  }
  useEffect(() => { alive.current = true; generation.current++; setOwner(props.contextKey); clear(); setError(''); setDraft(emptyFilters()); setFilters(emptyFilters()); setBusy(false); if (props.available) void list(emptyFilters()); return () => { alive.current = false; generation.current++; }; }, [props.contextKey, props.readOnly, props.available, props.reader]);
  const previousRefresh = useRef(props.refresh); useEffect(() => { if (previousRefresh.current !== props.refresh) { previousRefresh.current = props.refresh; if (props.available) void list(filters); } }, [props.refresh]);
  const visible = owner === props.contextKey && props.available && props.contextKey.split(':')[3] === String(props.readOnly), shown = visible ? detail : null, canRead = visible && flags?.can_read, values = visible && flags?.can_read_value && shown?.document.value_available;
  return <section className="warehouse-wz-issued" aria-label="Wystawione automatyczne WZ"><header><h3>Wystawione automatyczne WZ</h3><p>Odczyt dokumentów zapisanych przy rzeczywistym wydaniu towaru. Historia nie wystawia nowych WZ i nie zmienia zapasu.</p></header>
    {!props.available && <p role="status">Odczyt zapisanych automatycznych WZ nie jest dostępny.</p>}{props.readOnly && <p>Kopia odtworzona — tylko odczyt i eksport.</p>}{visible && error && <p role="alert">{error}</p>}{visible && busy && <p role="status">Trwa odczyt WZ.</p>}
    <form className="wwi-filters" onSubmit={e => { e.preventDefault(); const f = { ...draft, order_id: draft.order_id.trim() }; setFilters(f); void list(f); }}><label>Magazyn wystawionych WZ<select value={draft.warehouse_id} disabled={busy || !props.available} onChange={e => setDraft(v => ({ ...v, warehouse_id: e.target.value }))}><option value="">Wszystkie własne magazyny</option>{visible && warehouses.map(w => <option key={w.id} value={w.id}>{w.code} — {w.name}</option>)}</select></label><label>Identyfikator zamówienia WZ<input value={draft.order_id} disabled={busy || !props.available} onChange={e => setDraft(v => ({ ...v, order_id: e.target.value }))}/></label><button className="button" disabled={busy || !props.available}>Zastosuj filtry WZ</button><button className="button" type="button" disabled={busy || !props.available} onClick={() => void list(filters)}>Odśwież wystawione WZ</button></form>
    {visible && loaded && !heads.length && <p>Brak wystawionych WZ dla tych filtrów.</p>}{visible && heads.length > 0 && <div className="wwi-scroll"><table><caption>Wystawione WZ — odczytano {heads.length}</caption><thead><tr><th>Numer i magazyn</th><th>Źródło wydania</th><th>Pozycje / ilość</th><th>Odczyt</th></tr></thead><tbody>{heads.map(h => <tr key={h.id}><td>{h.number}<small>{h.warehouse.code} — {h.warehouse.name} · historyczne nazwy · {h.created_at}</small></td><td>{sourceNames[h.source.kind]}<small>Zamówienie {h.source.order_id}</small></td><td>{h.row_count} pozycji · {h.summary.physical_quantity} szt.</td><td><button className="button" type="button" disabled={busy || !canRead} onClick={() => void open(h)}>Otwórz WZ {h.number}</button></td></tr>)}</tbody></table></div>}
    {visible && cursor && <button className="button" type="button" disabled={busy || !canRead} onClick={() => void list(filters, true)}>Wczytaj kolejne WZ (do 50)</button>}
    {shown && <article className="wwi-detail"><h4>{shown.document.number}</h4><p>Pełny odczyt {shown.rows.length} zapisanych pozycji · data odczytu {shown.snapshot_at}.</p><p>{shown.document.warehouse.code} — {shown.document.warehouse.name} · nazwy historyczne · seria {shown.document.series_id} · rok {shown.document.year} · sekwencja {shown.document.sequence}</p><p>{sourceNames[shown.document.source.kind]} · zamówienie {shown.document.source.order_id} · przesyłka {shown.document.source.shipment_id}{shown.document.source.parcel_index !== undefined && <> · indeks paczki {shown.document.source.parcel_index}</>}</p><div className="wwi-actions">{props.onOpenOrder && <button className="button" type="button" disabled={busy} onClick={() => latest.current.onOpenOrder?.(shown.document.source.order_id)}>Otwórz zamówienie WZ</button>}{props.onOpenShipment && <button className="button" type="button" disabled={busy} onClick={() => latest.current.onOpenShipment?.(shown.document.source.order_id, shown.document.source.shipment_id)}>Otwórz przesyłkę WZ</button>}</div><p>Pokwitowanie wydania {shown.document.receipt_id}. Zapisane pozycje są historią wydania, nie bieżącym stanem magazynu.</p>
      {values ? <p>Znana wartość: {amount(shown.document.summary.known_value_minor, shown.document.summary)} · ilość z nieznanym kosztem: {shown.document.summary.unknown_quantity} szt.</p> : <p>Historyczna wycena WZ niedostępna w tym odczycie.</p>}
      <div className="wwi-scroll"><table><caption>Oryginalne pozycje zamówienia i przypisanie wydania</caption><thead><tr><th>Pozycja zamówienia</th><th>Pozycje i ilości</th><th>Zapisana receptura</th><th>Przypisane wydania fizyczne</th></tr></thead><tbody>{shown.document.commercial_lines.map(l => <tr key={l.item_id}><td>{l.sku} — {l.name}<small>Pozycja zamówienia {l.item_id} · produkt {l.product_id}</small><small>Oryginalna wartość całej pozycji: {commercialAmount(l)}{l.vat !== undefined && <> · VAT {l.vat}%</>}</small></td><td>{l.lineage_kind === 'physical_item_components_v1' ? <>{l.component_quantities.map(c => <small key={c.product_id}>{c.product_id} · {c.quantity} szt. składnika</small>)}<small>Jawne przypisanie składników do historycznej pozycji; bez przypisanej ilości sprzedaży. Oryginalna pozycja: {l.original_quantity} szt.</small></> : <>{l.quantity} z {l.original_quantity} szt.<small>Ilość handlowa, niezależna od liczby fizycznych składników</small></>}</td><td>{l.components.map(c => <small key={c.product_id}>{c.product_id} · {c.quantity} szt. na jednostkę handlową</small>)}</td><td>{l.allocations.map(a => <small key={a.physical_id + ':' + a.product_id + ':' + a.warehouse_id}>Wydanie {a.physical_id} · produkt {a.product_id} · magazyn {a.warehouse_id} · {a.quantity} szt.{a.warehouse_id !== shown.document.warehouse.id && ' · inny magazyn tego wydania'}</small>)}</td></tr>)}</tbody></table></div>
      <div className="wwi-scroll"><table><caption>Pełne zapisane pozycje WZ {shown.document.number}</caption><thead><tr><th>Produkt / pozycja</th><th>Ilość / lokalizacja</th><th>Źródłowe ruchy</th><th>Koszt jednostkowy / wartość</th></tr></thead><tbody>{shown.rows.slice(page * 100, (page + 1) * 100).map(r => <tr key={r.ordinal}><td>{r.sku} — {r.name}<small>Pozycja {r.ordinal + 1} · {r.product_id}</small></td><td>{r.quantity} szt. · {r.location}</td><td>Ruch zapasu {r.stock_movement_id}<small>Ruch lokalizacji {r.location_movement_id}</small>{r.issue_fragment_id && <small>Fragment WMS {r.issue_fragment_id} · warstwa {r.layer_id}</small>}</td><td>{values ? <>{amount(r.unit_cost_minor, shown.document.summary)} · {amount(r.value_minor, shown.document.summary)}</> : 'Wycena niedostępna'}</td></tr>)}</tbody></table></div>
      <div className="wwi-actions"><button className="button" type="button" disabled={busy || page === 0} onClick={() => setPage(v => v - 1)}>Poprzednie pozycje WZ</button><span>Strona {page + 1}/{Math.ceil(shown.rows.length / 100)}</span><button className="button" type="button" disabled={busy || (page + 1) * 100 >= shown.rows.length} onClick={() => setPage(v => v + 1)}>Następne pozycje WZ</button></div>
      <div className="wwi-actions"><label>Format eksportu WZ<select value={format} disabled={busy} onChange={e => setFormat(e.target.value as 'csv' | 'xml')}><option value="csv">CSV</option><option value="xml">XML</option></select></label><label className="wwi-check"><input type="checkbox" checked={includeValues} disabled={busy || !values} onChange={e => setIncludeValues(e.target.checked)}/>Dołącz historyczną wycenę WZ</label><button className="button" type="button" disabled={busy || !canRead} onClick={() => void download()}>Pobierz pełny zapisany WZ</button></div>{downloaded && <p role="status">{downloaded}</p>}
    </article>}
  </section>;
}
