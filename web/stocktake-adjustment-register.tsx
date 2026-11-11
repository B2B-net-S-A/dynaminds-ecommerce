import { useEffect, useRef, useState } from 'react';
import { api, ApiError, date } from './api';
import type { AdjustmentDocument, AdjustmentDocumentRow, AdjustmentFlags, AdjustmentReceipt, AdjustmentTotals } from '../server/stocktake-adjustments-schema';
import './stocktake-adjustment-register.css';

const base = '/stocktake-adjustments';
type Flags = AdjustmentFlags;
type Filters = { kind: string; source_kind: string; warehouse_id: string; number_prefix: string; from: string; to: string };
type ListReply = Flags & { data: AdjustmentDocument[]; meta: { cursor: string | null; limit: number } };
type RowsReply = Flags & { document_id: string; data: AdjustmentDocumentRow[]; meta: { cursor: string | null; total: number } };
type ExportReply = Flags & { document: AdjustmentDocument; filename: string; content_type: string; content: string; format: 'csv' | 'xml'; values_included: boolean; row_count: number };
type Detail = { document: AdjustmentDocument; rows: AdjustmentDocumentRow[]; receipt: AdjustmentReceipt };
const emptyFilters = (): Filters => ({ kind: '', source_kind: '', warehouse_id: '', number_prefix: '', from: '', to: '' });
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v);
const natural = (v: unknown): v is string => typeof v === 'string' && /^(0|[1-9]\d*)$/.test(v) && BigInt(v) <= 9223372036854775807n;
const positive = (v: unknown): v is string => natural(v) && v !== '0';
const timestamp = (v: unknown) => typeof v === 'string' && Number.isFinite(Date.parse(v));
const valueFields = new Set(['unit_cost_minor', 'value_minor', 'currency', 'exponent', '_exponent', 'known_pw_minor', 'known_rw_minor', 'unknown_pw_quantity', 'unknown_rw_quantity', 'rows_sha256']);
function redact<T>(v: T): T {
  if (Array.isArray(v)) return v.map(redact) as T;
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([k]) => !valueFields.has(k)).map(([k, x]) => [k, redact(x)])) as T;
  return v;
}
function canonical(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => JSON.stringify(k) + ':' + canonical(x)).join(',') + '}';
  return JSON.stringify(v) ?? 'undefined';
}
function totals(s: AdjustmentTotals) {
  if (!s || !natural(s.pw_quantity) || !natural(s.rw_quantity)) throw Error('Niepełne ilości dokumentu.');
  const fields = ['known_pw_minor', 'known_rw_minor', 'unknown_pw_quantity', 'unknown_rw_quantity'] as const;
  if (fields.some(k => s[k] !== undefined && !natural(s[k]))) throw Error('Niepełna wycena dokumentu.');
  if ([...fields, 'currency', 'exponent'].some(k => s[k as keyof AdjustmentTotals] !== undefined) && (fields.some(k => s[k] === undefined) || s.currency === undefined || s.exponent === undefined)) throw Error('Niepełna wycena dokumentu.');
  if ((s.currency === undefined) !== (s.exponent === undefined) || (s.currency !== undefined && (!/^[A-Z]{3}$/.test(s.currency) || !Number.isInteger(s.exponent) || s.exponent! < 0 || s.exponent! > 6))) throw Error('Niepełna waluta historycznej wyceny.');
}
function documentHead(d: AdjustmentDocument) {
  if (!d || !uuid(d.id) || !uuid(d.receipt_id) || !uuid(d.series_id) || !uuid(d.stocktake_id) || !['PW', 'RW'].includes(d.kind) || !['quantity', 'wms'].includes(d.source_kind) || !positive(d.sequence) || !Number.isInteger(d.year) || d.year < 1900 || d.year > 9999 || typeof d.number !== 'string' || !d.number || !Number.isInteger(d.row_count) || d.row_count < 1 || d.row_count > 10000 || !timestamp(d.created_at) || !uuid(d.warehouse?.id) || typeof d.warehouse.name !== 'string' || typeof d.warehouse.code !== 'string' || !d.warehouse.policy || !['sale', 'custody'].includes(d.warehouse.policy.usage) || typeof d.warehouse.policy.enabled !== 'boolean' || !natural(d.warehouse.policy.version)) throw Error('Niepełny nagłówek PW/RW.');
  if (d.warehouse.policy.version === '0' && (d.warehouse.policy.usage !== 'sale' || !d.warehouse.policy.enabled)) throw Error('Nieprawidłowa historyczna polityka magazynu.');
  totals(d.summary);
  if ((d.kind === 'PW' ? BigInt(d.summary.pw_quantity) < 1n || d.summary.rw_quantity !== '0' : BigInt(d.summary.rw_quantity) < 1n || d.summary.pw_quantity !== '0')) throw Error('Podsumowanie ma inny kierunek dokumentu.');
}
function manifest(rows: AdjustmentDocumentRow[], d: AdjustmentDocument) {
  if (rows.length !== d.row_count) throw Error('Brakuje części pełnego dokumentu.');
  const sourceOrdinals = new Set<number>(), movements = new Set<string>(); let q = 0n, known = 0n, unknown = 0n;
  rows.forEach((r, i) => {
    if (r.ordinal !== i || !Number.isInteger(r.source_ordinal) || r.source_ordinal < 0 || sourceOrdinals.has(r.source_ordinal) || !uuid(r.line_id) || !uuid(r.product_id) || !uuid(r.movement_id) || movements.has(r.movement_id) || r.warehouse_id !== d.warehouse.id || r.kind !== d.kind || typeof r.sku !== 'string' || typeof r.name !== 'string' || typeof r.location !== 'string' || !r.location || !Number.isSafeInteger(r.quantity) || r.quantity <= 0 || r.delta !== (d.kind === 'PW' ? r.quantity : -r.quantity) || (r.stock_movement_id !== null && !uuid(r.stock_movement_id))) throw Error('Wiersze nie mają pełnego powiązania z dokumentem i ruchami.');
    for (const k of ['lot_id', 'layer_id'] as const) if (r[k] !== null && !uuid(r[k])) throw Error('Niepełna tożsamość warstwy lub partii.');
    if (r.unit_cost_minor !== undefined && r.unit_cost_minor !== null && !natural(r.unit_cost_minor)) throw Error('Nieprawidłowy koszt historyczny.');
    if (r.value_minor !== undefined && r.value_minor !== null && !natural(r.value_minor)) throw Error('Nieprawidłowa wartość historyczna.');
    if ([r.unit_cost_minor, r.value_minor, r.currency].some(v => v !== undefined) !== (d.summary.currency !== undefined) || (d.summary.currency !== undefined && (d.source_kind !== 'wms' || r.unit_cost_minor === undefined || r.value_minor === undefined || r.currency === undefined))) throw Error('Niepełna wycena fragmentu.');
    if (r.unit_cost_minor !== undefined && (r.currency !== d.summary.currency || (r.unit_cost_minor === null) !== (r.value_minor === null) || (r.unit_cost_minor !== null && BigInt(r.value_minor!) !== BigInt(r.unit_cost_minor) * BigInt(r.quantity)))) throw Error('Wycena fragmentu nie odpowiada zamrożonej ilości.');
    sourceOrdinals.add(r.source_ordinal); movements.add(r.movement_id); q += BigInt(r.quantity);
    if (r.value_minor === null) unknown += BigInt(r.quantity); else if (r.value_minor !== undefined) known += BigInt(r.value_minor);
  });
  if (q.toString() !== (d.kind === 'PW' ? d.summary.pw_quantity : d.summary.rw_quantity)) throw Error('Pełne wiersze nie odpowiadają ilości nagłówka.');
  const knownTotal = d.kind === 'PW' ? d.summary.known_pw_minor : d.summary.known_rw_minor, unknownTotal = d.kind === 'PW' ? d.summary.unknown_pw_quantity : d.summary.unknown_rw_quantity;
  if ((knownTotal !== undefined && known.toString() !== knownTotal) || (unknownTotal !== undefined && unknown.toString() !== unknownTotal)) throw Error('Pełne wiersze nie odpowiadają wycenie nagłówka.');
}
function receiptGraph(r: AdjustmentReceipt, d: AdjustmentDocument, rows: AdjustmentDocumentRow[]) {
  if (!r || r.id !== d.receipt_id || !uuid(r.preview_id) || !uuid(r.client_key) || !/^[a-f0-9]{64}$/.test(r.scope_hash) || !timestamp(r.created_at) || r.request?.client_key !== r.client_key || r.request.scope_hash !== r.scope_hash || r.request.confirmed !== true || r.source?.state !== 'posted' || !positive(r.source.version) || !r.snapshot || !Array.isArray(r.documents) || r.documents.length < 1 || r.documents.length > 2) throw Error('Niepełne powiązanie pokwitowania.');
  const s = r.snapshot.source; totals(r.snapshot.summary); totals(s?.summary);
  if (s.source_kind !== d.source_kind || s.stocktake_id !== d.stocktake_id || r.source.source_kind !== d.source_kind || r.source.stocktake_id !== d.stocktake_id || !positive(s.version) || r.source.version !== (BigInt(s.version) + 1n).toString() || canonical(s.warehouse) !== canonical(d.warehouse) || r.snapshot.year !== d.year || !Number.isInteger(r.snapshot.row_count) || r.snapshot.row_count !== s.row_count || r.snapshot.row_count > 10000 || canonical(s.summary) !== canonical(r.snapshot.summary) || rows.some(x => x.source_ordinal >= r.snapshot.row_count)) throw Error('Pokwitowanie nie odpowiada oryginalnemu spisowi.');
  if (d.source_kind === 'wms' ? !uuid(r.source.posting_id) || !uuid(r.source.operation_id) : r.source.posting_id !== null || r.source.operation_id !== null) throw Error('Niepełny zapis rzeczywistego postowania.');
  const kinds = new Set<string>(); let count = 0;
  for (const h of r.documents) {
    documentHead(h); const series = r.snapshot.series[h.kind];
    if (!series || series.id !== h.series_id || series.kind !== h.kind || series.version !== '1' || typeof series.prefix !== 'string' || kinds.has(h.kind) || h.receipt_id !== r.id || h.stocktake_id !== d.stocktake_id || h.source_kind !== d.source_kind || canonical(h.warehouse) !== canonical(d.warehouse) || h.year !== r.snapshot.year || h.number !== `${series.prefix}/${h.year}/${h.sequence.padStart(6, '0')}`) throw Error('Zapisany numer lub źródło dokumentu jest niezgodne.');
    for (const k of ['pw_quantity', 'rw_quantity', 'known_pw_minor', 'known_rw_minor', 'unknown_pw_quantity', 'unknown_rw_quantity'] as const) if (r.snapshot.summary[k] !== undefined && h.summary[k] !== (k.includes(h.kind.toLowerCase()) ? r.snapshot.summary[k] : '0')) throw Error('Pokwitowanie ma inne ilości lub wartości dokumentu.');
    if (h.summary.currency !== r.snapshot.summary.currency || h.summary.exponent !== r.snapshot.summary.exponent) throw Error('Pokwitowanie ma inną walutę.');
    kinds.add(h.kind); count += h.row_count;
  }
  if (count !== r.snapshot.row_count || canonical(r.documents.find(x => x.id === d.id)) !== canonical(d)) throw Error('Pokwitowanie nie zawiera pełnego wybranego dokumentu.');
  for (const kind of ['PW', 'RW'] as const) if ((BigInt(kind === 'PW' ? r.snapshot.summary.pw_quantity : r.snapshot.summary.rw_quantity) > 0n) !== kinds.has(kind)) throw Error('Pokwitowanie pomija wymagany dokument.');
}
function money(v: string | null | undefined, s: AdjustmentTotals) {
  if (v === undefined || !s.currency || s.exponent === undefined) return 'Wycena niedostępna';
  if (v === null) return 'Koszt nieznany (NULL)';
  const n = BigInt(v), div = 10n ** BigInt(s.exponent);
  return `${n / div}${s.exponent ? ',' + (n % div).toString().padStart(s.exponent, '0') : ''} ${s.currency}`;
}
class OldRead extends Error {}
export type StocktakeAdjustmentRegisterProps = { contextKey: string; available: boolean; readOnly: boolean; refresh: number; onOpenStocktake?: (sourceKind: 'quantity' | 'wms', stocktakeId: string) => void };
export function StocktakeAdjustmentRegister(props: StocktakeAdjustmentRegisterProps) {
  const latest = useRef(props); latest.current = props;
  const generation = useRef(0), live = useRef(true), cursors = useRef(new Set<string>());
  const [owner, setOwner] = useState(props.contextKey), [draft, setDraft] = useState(emptyFilters), [filters, setFilters] = useState(emptyFilters);
  const [heads, setHeads] = useState<AdjustmentDocument[]>([]), [cursor, setCursor] = useState<string | null>(null), [warehouses, setWarehouses] = useState<{ id: string; name: string; code: string }[]>([]);
  const [access, setAccess] = useState<Flags | null>(null), [busy, setBusy] = useState(false), [loaded, setLoaded] = useState(false), [error, setError] = useState('');
  const [detail, setDetail] = useState<Detail | null>(null), [page, setPage] = useState(0), [format, setFormat] = useState<'csv' | 'xml'>('csv'), [includeValues, setIncludeValues] = useState(false), [downloaded, setDownloaded] = useState('');
  const visible = owner === props.contextKey;
  function clear() { setHeads([]); setCursor(null); setDetail(null); setIncludeValues(false); setDownloaded(''); setAccess(null); setWarehouses([]); setLoaded(false); setBusy(false); cursors.current.clear(); }
  function current(g: number, ctx: string) { return live.current && generation.current === g && latest.current.contextKey === ctx && latest.current.available && ctx.split(':')[3] === String(latest.current.readOnly); }
  function flagCheck(f: Flags, ctx: string) {
    const parts = ctx.split(':');
    if (parts.length !== 4 || !uuid(parts[0]) || !uuid(parts[1]) || !['admin', 'operator', 'viewer'].includes(parts[2]) || !['true', 'false'].includes(parts[3]) || parts[3] !== String(latest.current.readOnly) || !f || ['available', 'read_only', 'can_read', 'can_write', 'can_read_value'].some(k => typeof f[k as keyof Flags] !== 'boolean') || f.current_role !== parts[2] || f.read_only !== latest.current.readOnly) throw new ApiError('Zmienił się kontekst lub prawo odczytu rejestru.', 403);
  }
  function keepFlags(f: Flags) {
    setAccess(f);
    if (!f.can_read_value) { setHeads(v => redact(v)); setDetail(v => v ? redact(v) : null); setIncludeValues(false); setDownloaded(''); }
  }
  async function identity(g: number, ctx: string) {
    const m = await api<{ user: { id: string; tenant_id: string; role: string } }>('/auth/me'); if (!current(g, ctx)) throw new OldRead();
    if (`${m.user?.tenant_id}:${m.user?.id}:${m.user?.role}:${latest.current.readOnly}` !== ctx) throw new ApiError('Zmieniła się firma lub użytkownik rejestru.', 403);
  }
  async function options(g: number, ctx: string) {
    await identity(g, ctx); const o = await api<Flags>(base + '/options'); if (!current(g, ctx)) throw new OldRead(); flagCheck(o, ctx); keepFlags(o);
    if (!o.available) throw Error('Moduł dokumentów korekt nie jest dostępny w tej kopii.');
    if (!o.can_read) throw new ApiError('Brak prawa odczytu rejestru PW/RW.', 403); return o;
  }
  async function get<T extends Flags>(path: string, g: number, ctx: string) {
    const d = await api<T>(path); if (!current(g, ctx)) throw new OldRead(); flagCheck(d, ctx);
    if (!d.available || !d.can_read) throw new ApiError('Brak bieżącego odczytu dokumentów.', 403); keepFlags(d); return d.can_read_value ? d : redact(d);
  }
  async function read(work: (g: number, ctx: string, flags: Flags) => Promise<void>) {
    const ctx = latest.current.contextKey, g = ++generation.current; setBusy(true); setError(''); setDownloaded('');
    try { if (!latest.current.available) throw Error('Moduł dokumentów korekt nie jest dostępny w tej kopii.'); const o = await options(g, ctx); await work(g, ctx, o); }
    catch (e) { if (current(g, ctx)) { clear(); setError(e instanceof Error ? e.message : 'Nie udało się odczytać rejestru.'); } }
    finally { if (current(g, ctx)) setBusy(false); }
  }
  function query(f: Filters, next?: string) {
    const q = new URLSearchParams({ limit: '50' });
    for (const k of ['kind', 'source_kind', 'warehouse_id', 'number_prefix'] as const) if (f[k]) q.set(k, f[k]);
    for (const k of ['from', 'to'] as const) if (f[k]) { const t = new Date(f[k]); if (!Number.isFinite(t.getTime())) throw Error('Podaj prawidłowe daty filtra.'); q.set(k, t.toISOString()); }
    if (f.from && f.to && new Date(f.from) > new Date(f.to)) throw Error('Data początkowa musi poprzedzać końcową.');
    if (f.number_prefix.length > 100 || /[\u0000-\u001f\u007f]/.test(f.number_prefix)) throw Error('Prefiks numeru jest nieprawidłowy.');
    if (next) q.set('cursor', next); return q;
  }
  async function list(f: Filters, more = false) {
    if (!more) { setHeads([]); setDetail(null); setCursor(null); setLoaded(false); cursors.current.clear(); }
    const prior = more ? heads : [], priorCursor = more ? cursor : null;
    await read(async (g, ctx, initial) => {
      if (!more) { const w = await api<{ data: { id: string; name: string; code: string }[] }>('/warehouses'); if (!current(g, ctx)) throw new OldRead(); if (!Array.isArray(w.data) || w.data.length > 200 || w.data.some(x => !uuid(x.id) || typeof x.name !== 'string' || typeof x.code !== 'string')) throw Error('Niepełna lista własnych magazynów.'); setWarehouses(w.data); }
      if (more && !priorCursor) throw Error('Brak kolejnej strony rejestru.');
      const d = await get<ListReply>(base + '/register?' + query(f, priorCursor ?? undefined), g, ctx);
      if (!Array.isArray(d.data) || d.data.length > 50 || d.meta?.limit !== 50 || (d.meta.cursor !== null && (typeof d.meta.cursor !== 'string' || !d.meta.cursor || d.meta.cursor.length > 4096 || cursors.current.has(d.meta.cursor)))) throw Error('Nieprawidłowy kursor lub strona rejestru.');
      d.data.forEach(documentHead);
      const all = [...prior, ...d.data], ids = new Set(all.map(x => x.id));
      if (ids.size !== all.length || (d.meta.cursor !== null && d.data.length === 0) || d.data.some(x => (f.kind && x.kind !== f.kind) || (f.source_kind && x.source_kind !== f.source_kind) || (f.warehouse_id && x.warehouse.id !== f.warehouse_id) || (f.number_prefix && !x.number.startsWith(f.number_prefix)) || (f.from && Date.parse(x.created_at) < new Date(f.from).getTime()) || (f.to && Date.parse(x.created_at) > new Date(f.to).getTime()))) throw Error('Strona nie odpowiada zastosowanym filtrom lub powtarza dokument.');
      for (let i = 1; i < all.length; i++) if (Date.parse(all[i].created_at) > Date.parse(all[i - 1].created_at) || (all[i].created_at === all[i - 1].created_at && all[i].id >= all[i - 1].id)) throw Error('Rejestr ma nieprawidłową kolejność.');
      const final = await options(g, ctx); if (d.meta.cursor) cursors.current.add(d.meta.cursor); setHeads(initial.can_read_value && final.can_read_value && d.can_read_value ? all : redact(all)); setCursor(d.meta.cursor); setLoaded(true);
    });
  }
  async function openDocument(id: string) {
    setDetail(null); setPage(0); setIncludeValues(false);
    await read(async (g, ctx, initial) => {
      const head = await get<Flags & { document: AdjustmentDocument }>(base + '/documents/' + id, g, ctx); documentHead(head.document); if (head.document.id !== id) throw Error('Odczytano inny dokument.');
      const rows: AdjustmentDocumentRow[] = []; let next: string | null = null; const seen = new Set<string>(); let values = initial.can_read_value && head.can_read_value;
      do {
        const q = new URLSearchParams({ limit: '100' }); if (next !== null) q.set('cursor', next);
        const r = await get<RowsReply>(base + '/documents/' + id + '/rows?' + q, g, ctx); values &&= r.can_read_value;
        if (r.document_id !== id || !Array.isArray(r.data) || r.data.length > 100 || r.meta?.total !== head.document.row_count || (r.meta.cursor !== null && (typeof r.meta.cursor !== 'string' || !/^(0|[1-9]\d{0,4})$/.test(r.meta.cursor) || seen.has(r.meta.cursor) || Number(r.meta.cursor) !== rows.length + r.data.length))) throw Error('Niepełna strona dokumentu.');
        rows.push(...r.data); if (rows.length > head.document.row_count || (r.meta.cursor !== null && r.data.length === 0)) throw Error('Niepełny manifest dokumentu.'); next = r.meta.cursor; if (next) seen.add(next);
      } while (next !== null);
      const reply = await get<Flags & { receipt: AdjustmentReceipt; documents: AdjustmentDocument[] }>(base + '/receipts/' + head.document.receipt_id, g, ctx); values &&= reply.can_read_value;
      const final = await options(g, ctx); values &&= final.can_read_value;
      const data: Detail = values ? { document: head.document, rows, receipt: reply.receipt } : redact({ document: head.document, rows, receipt: reply.receipt });
      if (canonical(values ? reply.documents : redact(reply.documents)) !== canonical(data.receipt.documents)) throw Error('Pokwitowanie ma inną listę dokumentów.'); manifest(data.rows, data.document); receiptGraph(data.receipt, data.document, data.rows); setDetail(data);
    });
  }
  async function download() {
    if (!detail) return; const frozen = detail.document, chosenFormat = format, chosenValues = includeValues;
    await read(async (g, ctx, initial) => {
      if (chosenValues && !initial.can_read_value) throw new ApiError('Odebrano prawo odczytu wyceny.', 403);
      const d = await get<ExportReply>(base + '/documents/' + frozen.id + '/export?' + new URLSearchParams({ format: chosenFormat, include_values: String(chosenValues) }), g, ctx);
      documentHead(d.document);
      if (canonical(redact(d.document)) !== canonical(redact(frozen)) || d.format !== chosenFormat || d.values_included !== chosenValues || d.row_count !== frozen.row_count || typeof d.content !== 'string' || new TextEncoder().encode(d.content).length > 5 * 1024 * 1024 || d.content_type !== (chosenFormat === 'csv' ? 'text/csv; charset=utf-8' : 'application/xml; charset=utf-8') || typeof d.filename !== 'string' || !/^[^/\\\u0000-\u001f\u007f]{1,200}$/.test(d.filename) || !d.filename.endsWith('.' + chosenFormat)) throw Error('Niepełny lub niezgodny eksport dokumentu.');
      if (chosenValues && (!d.can_read_value || canonical(d.document) !== canonical(frozen))) throw Error('Eksport ma inną wycenę dokumentu.');
      const final = await options(g, ctx); if (chosenValues && !final.can_read_value) throw Error('Odebrano prawo wyceny przed pobraniem. Odczytaj dokument bez kosztów.');
      if (!current(g, ctx)) throw new OldRead();
      const url = URL.createObjectURL(new Blob([d.content], { type: d.content_type }));
      try { const a = document.createElement('a'); a.href = url; a.download = d.filename; document.body.append(a); a.click(); a.remove(); }
      finally { URL.revokeObjectURL(url); }
      setDownloaded('Przekazano plik do pobrania: ' + d.filename + '. To nie jest potwierdzenie zapisania pliku lub wydruku.');
    });
  }
  useEffect(() => {
    live.current = true; setOwner(props.contextKey); clear(); setDraft(emptyFilters()); setFilters(emptyFilters()); setError('');
    if (props.available) void list(emptyFilters());
    return () => { live.current = false; generation.current++; };
  }, [props.contextKey, props.readOnly, props.available]);
  const previousRefresh = useRef(props.refresh);
  useEffect(() => { if (previousRefresh.current !== props.refresh) { previousRefresh.current = props.refresh; if (props.available) void list(filters); } }, [props.refresh]);
  const shownHeads = visible ? heads : [], shownDetail = visible ? detail : null, canRead = visible && access?.can_read, cost = visible && access?.can_read_value;
  return <section className="sar-panel" aria-label="Rejestr PW/RW wszystkich spisów"><div className="panel-heading"><div><h2>Rejestr PW/RW wszystkich spisów</h2><p>Zapisane korekty inwentaryzacji. Odczyt nie rozlicza spisu ani nie zmienia zapasu.</p></div></div>
    {!props.available && <p role="status">Moduł dokumentów korekt nie jest dostępny w tej kopii.</p>}
    {props.readOnly && <p>Odtworzona kopia — tylko odczyt dokumentów i eksportów.</p>}
    {visible && error && <p role="alert" className="notice import-error">{error}</p>}
    {visible && busy && <p role="status">Trwa odczyt rejestru. Nie wykonuje zapisów.</p>}
    <form className="sar-filters" onSubmit={e => { e.preventDefault(); const f = { ...draft, number_prefix: draft.number_prefix.trim() }; setFilters(f); void list(f); }}>
      <label>Rodzaj dokumentu<select value={draft.kind} onChange={e => setDraft(v => ({ ...v, kind: e.target.value }))}><option value="">PW i RW</option><option>PW</option><option>RW</option></select></label>
      <label>Źródło spisu<select value={draft.source_kind} onChange={e => setDraft(v => ({ ...v, source_kind: e.target.value }))}><option value="">Wszystkie źródła</option><option value="quantity">Spis ilościowy (OFF)</option><option value="wms">Spis WMS (ON)</option></select></label>
      <label>Magazyn<select value={draft.warehouse_id} onChange={e => setDraft(v => ({ ...v, warehouse_id: e.target.value }))}><option value="">Wszystkie własne magazyny</option>{visible && warehouses.map(w => <option key={w.id} value={w.id}>{w.code} — {w.name}</option>)}</select></label>
      <label>Początek numeru<input value={draft.number_prefix} maxLength={100} onChange={e => setDraft(v => ({ ...v, number_prefix: e.target.value }))}/></label>
      <label>Utworzono od<input type="datetime-local" value={draft.from} onChange={e => setDraft(v => ({ ...v, from: e.target.value }))}/></label>
      <label>Utworzono do<input type="datetime-local" value={draft.to} onChange={e => setDraft(v => ({ ...v, to: e.target.value }))}/></label>
      <button className="button" disabled={!props.available || busy}>Zastosuj filtry PW/RW</button><button type="button" className="button" disabled={!props.available || busy} onClick={() => void list(filters)}>Odśwież rejestr PW/RW</button>
    </form>
    {visible && loaded && !shownHeads.length && <p>Brak dokumentów odpowiadających zastosowanym filtrom.</p>}
    {!!shownHeads.length && <div className="sar-scroll"><table><caption>Zapisane dokumenty PW/RW — odczytano {shownHeads.length}</caption><thead><tr><th>Numer / rodzaj</th><th>Magazyn historyczny</th><th>Źródło / data</th><th>Fragmenty / ilość</th><th>Odczyt</th></tr></thead><tbody>{shownHeads.map(d => <tr key={d.id}><td>{d.number}<small>{d.kind} · zapisany</small></td><td>{d.warehouse.code} — {d.warehouse.name}<small>{d.warehouse.policy.usage === 'custody' ? 'CUSTODY — poza sprzedażą' : 'SALE'} · polityka {d.warehouse.policy.version}</small></td><td>{d.source_kind === 'wms' ? 'Spis WMS' : 'Spis ilościowy'}<small>{date(d.created_at)}</small></td><td>{d.row_count} fragmentów · {d.kind === 'PW' ? d.summary.pw_quantity : d.summary.rw_quantity} szt.</td><td><button type="button" className="button" disabled={busy || !canRead} onClick={() => void openDocument(d.id)}>Otwórz dokument {d.number}</button></td></tr>)}</tbody></table></div>}
    {visible && cursor && <button type="button" className="button" disabled={busy || !canRead} onClick={() => void list(filters, true)}>Wczytaj kolejne dokumenty PW/RW (do 50)</button>}
    {shownDetail && <article className="sar-detail"><h3>{shownDetail.document.number}</h3><p>Odczytano wszystkie {shownDetail.rows.length} fragmentów. Dokument jest zapisanym skutkiem spisu; nie można go ponownie zatwierdzić.</p><p>{shownDetail.document.warehouse.code} — {shownDetail.document.warehouse.name} · historyczne przeznaczenie {shownDetail.document.warehouse.policy.usage.toUpperCase()} · rok {shownDetail.document.year} · sekwencja {shownDetail.document.sequence}</p>
      <p>Pokwitowanie {shownDetail.receipt.id} · {date(shownDetail.receipt.created_at)} · spis {shownDetail.receipt.snapshot.source.name} · wersja po rozliczeniu {shownDetail.receipt.source.version}</p>
      <p>Dokumenty pokwitowania: {shownDetail.receipt.documents.map(d => d.number).join(' · ')}</p>
      <p>{shownDetail.document.kind}: {shownDetail.document.kind === 'PW' ? shownDetail.document.summary.pw_quantity : shownDetail.document.summary.rw_quantity} szt.{cost && shownDetail.document.summary.currency && <> · znana wartość {money(shownDetail.document.kind === 'PW' ? shownDetail.document.summary.known_pw_minor : shownDetail.document.summary.known_rw_minor, shownDetail.document.summary)} · ilość z nieznanym kosztem {shownDetail.document.kind === 'PW' ? shownDetail.document.summary.unknown_pw_quantity : shownDetail.document.summary.unknown_rw_quantity} szt.</>}</p>
      {props.onOpenStocktake && <button type="button" className="button" disabled={busy} onClick={() => props.onOpenStocktake?.(shownDetail.document.source_kind, shownDetail.document.stocktake_id)}>Otwórz źródłowy spis</button>}
      <div className="sar-scroll"><table><caption>Pełne fragmenty dokumentu {shownDetail.document.number}</caption><thead><tr><th>Produkt / oryginalna pozycja</th><th>Ilość / kierunek</th><th>Lokalizacja / warstwa</th><th>Powiązanie ruchu</th><th>Historyczna wycena</th></tr></thead><tbody>{shownDetail.rows.slice(page * 100, (page + 1) * 100).map(r => <tr key={r.ordinal}><td>{r.sku} — {r.name}<small>Fragment {r.ordinal + 1} · źródłowy {r.source_ordinal + 1} · {r.line_id}</small></td><td>{r.quantity} szt. · {r.delta > 0 ? '+' : '−'}{r.quantity}</td><td>{r.location}<small>{r.lot_code ?? 'Bez partii'} · {r.layer_id ?? 'Bez warstwy kosztowej'}</small></td><td>{r.movement_id}<small>{r.stock_movement_id ?? 'Bez zbiorczego ruchu produktu'}</small></td><td>{cost ? money(r.unit_cost_minor, shownDetail.document.summary) : 'Wycena niedostępna'}<small>{cost && r.value_minor !== undefined ? 'Wartość ' + money(r.value_minor, shownDetail.document.summary) : ''}</small></td></tr>)}</tbody></table></div>
      <div className="sar-pages"><button type="button" className="button" disabled={page === 0 || busy} onClick={() => setPage(p => p - 1)}>Poprzednie fragmenty</button><span>Strona {page + 1}/{Math.ceil(shownDetail.rows.length / 100)}</span><button type="button" className="button" disabled={(page + 1) * 100 >= shownDetail.rows.length || busy} onClick={() => setPage(p => p + 1)}>Następne fragmenty</button></div>
      <div className="sar-export"><label>Format eksportu<select value={format} disabled={busy} onChange={e => setFormat(e.target.value as 'csv' | 'xml')}><option value="csv">CSV</option><option value="xml">XML</option></select></label><label className="sar-check"><input type="checkbox" checked={includeValues} disabled={busy || !cost || shownDetail.document.source_kind !== 'wms'} onChange={e => setIncludeValues(e.target.checked)}/>Dołącz historyczną wycenę</label><button type="button" className="button" disabled={busy || !canRead} onClick={() => void download()}>Pobierz pełny dokument PW/RW</button></div>
      {visible && downloaded && <p role="status">{downloaded}</p>}<p>Odczyt historii nie potwierdza niepewnej próby rozliczenia. Eksport nie stanowi księgowania COGS ani wydruku.</p>
    </article>}
  </section>;
}
