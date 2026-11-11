import { ensure } from './errors';
import type { CatalogStockCountPublicDocument, CatalogStockCountPublicRow } from './catalog-stock-count-query';

/** Pure serialization only. A server caller must approve current quantity/value IAM
 * after collecting the complete immutable manifest and before invoking this function. */
export type CatalogStockCountExportRow = CatalogStockCountPublicRow & {
  unit_cost_minor?: string | null; value_minor?: string | null; currency?: string; exponent?: number;
};
export type CatalogStockCountExportOptions = { format: 'csv' | 'xml'; includeValues: boolean };
export type CatalogStockCountValueBucket = {
  currency: string; exponent: number; known_quantity: string; zero_cost_quantity: string;
  unknown_quantity: string; known_value_minor: string; signed_known_value_minor: string;
};
export type CatalogStockCountExportValuation = {
  state: 'complete' | 'partial_unknown'; physical_quantity: string; buckets: CatalogStockCountValueBucket[];
};
export type CatalogStockCountExport = {
  document: CatalogStockCountPublicDocument; format: 'csv' | 'xml'; filename: string;
  content_type: 'text/csv; charset=utf-8' | 'application/xml; charset=utf-8'; content: string;
  values_included: boolean; row_count: number;
  value_state: 'not_requested' | 'unavailable_off' | 'complete' | 'partial_unknown';
  valuation?: CatalogStockCountExportValuation;
};
export const CATALOG_STOCK_COUNT_EXPORT_LIMITS = Object.freeze({ rows: 10000, response_bytes: 8388608 });
export const CATALOG_STOCK_COUNT_CSV_COLUMNS = Object.freeze([
  'record_type','document_id','receipt_id','source_id','execution_id','protocol','number','kind','series_id','year','sequence',
  'created_at','warehouse_id','warehouse_name','warehouse_code','wms_enabled','row_count','quantity','value_state',
  'ordinal','row_id','product_id','sku','name','location','delta','bin_movement_id','layer_movement_id','source_index',
  'stocktake_line_id','stocktake_posting_id','lot_id','layer_id',
] as const);
export const CATALOG_STOCK_COUNT_CSV_VALUE_COLUMNS = Object.freeze([
  'cost_state','unit_cost_minor','value_minor','currency','exponent','known_quantity','zero_cost_quantity',
  'unknown_quantity','known_value_minor','signed_known_value_minor',
] as const);
const headKeys = ['id','receipt_id','source_id','execution_id','protocol','warehouse_id','warehouse','kind','number',
  'year','sequence','series_id','row_count','quantity','wms_enabled','created_at'];
const rowKeys = ['id','ordinal','document_id','warehouse_id','product_id','sku','name','location','delta','quantity',
  'bin_movement_id','layer_movement_id','source_index','stocktake_line_id','stocktake_posting_id','lot_id','layer_id'];
const costKeys = ['unit_cost_minor','value_minor','currency','exponent'];
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const maximum = 9223372036854775807n;
type Cell = string | number | boolean | null | undefined;
type RecordCells = Record<string, Cell>;
type ValueRow = CatalogStockCountPublicRow & {
  cost_state: 'known' | 'unknown'; unit_cost_minor: string | null; value_minor: string | null;
  currency: string; exponent: number;
};
function valid(condition: unknown): asserts condition { ensure(condition, 409, 'Niepełny lub niespójny zamrożony manifest COUNT'); }
function record(v: unknown): Record<string, unknown> {
  valid(v !== null && typeof v === 'object' && !Array.isArray(v)); return v as Record<string, unknown>;
}
function whitelist(r: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []) {
  valid(required.every(k => Object.hasOwn(r, k)) && Object.keys(r).every(k => required.includes(k) || optional.includes(k)));
}
function identifier(v: unknown): asserts v is string { valid(typeof v === 'string' && uuid.test(v)); }
function integer(v: unknown, positive = false): asserts v is string {
  valid(typeof v === 'string' && (positive ? /^[1-9][0-9]{0,18}$/ : /^(0|[1-9][0-9]{0,18})$/).test(v) && BigInt(v) <= maximum);
}
function text(v: unknown): asserts v is string {
  valid(typeof v === 'string');
  // XML 1.0 Char production; also guarantees lossless UTF-8 CSV text.
  // Tab/CR/LF remain valid and receive normal quoting/formula protection.
  ensure(!/[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/u.test(v),
    422, 'Tekst dokumentu COUNT zawiera niedozwolony znak');
}
function head(input: CatalogStockCountPublicDocument): CatalogStockCountPublicDocument {
  const d = record(input); whitelist(d, headKeys);
  for (const k of ['id','receipt_id','source_id','execution_id','warehouse_id','series_id']) identifier(d[k]);
  const wh = record(d.warehouse); whitelist(wh, ['id','name','code']); identifier(wh.id); text(wh.name); text(wh.code);
  valid(wh.id === d.warehouse_id); valid(d.protocol === 'inventory_bulk' || d.protocol === 'stock_file');
  valid(d.kind === 'PW' || d.kind === 'RW'); text(d.number); text(d.created_at);
  valid(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(d.created_at) && Number.isFinite(Date.parse(d.created_at)));
  valid(Number.isInteger(d.year) && Number(d.year) >= 1 && Number(d.year) <= 9999);
  integer(d.sequence, true); integer(d.quantity, true);
  // COUNT creates its system series with prefix=kind; there is no user-defined
  // COUNT prefix. Preserve the actual publisher grammar and full sequence.
  valid(d.number === `${d.kind}/${d.year}/${d.sequence.padStart(6, '0')}`);
  valid(typeof d.row_count === 'number' && Number.isSafeInteger(d.row_count) && d.row_count >= 1);
  ensure(d.row_count <= CATALOG_STOCK_COUNT_EXPORT_LIMITS.rows, 413, 'Limit pełnego manifestu COUNT');
  valid(typeof d.wms_enabled === 'boolean');
  // Explicit projection and fixed field order. No raw/private object is serialized.
  return { id: input.id, receipt_id: input.receipt_id, source_id: input.source_id, execution_id: input.execution_id,
    protocol: input.protocol, warehouse_id: input.warehouse_id,
    warehouse: { id: input.warehouse.id, name: input.warehouse.name, code: input.warehouse.code },
    kind: input.kind, number: input.number, year: input.year, sequence: input.sequence, series_id: input.series_id,
    row_count: input.row_count, quantity: input.quantity, wms_enabled: input.wms_enabled, created_at: input.created_at };
}
function projectedRow(input: CatalogStockCountExportRow, d: CatalogStockCountPublicDocument, ordinal: number, values: boolean): CatalogStockCountPublicRow | ValueRow {
  const r = record(input); whitelist(r, rowKeys, costKeys);
  for (const k of ['id','document_id','warehouse_id','product_id']) identifier(r[k]);
  valid(r.document_id === d.id && r.warehouse_id === d.warehouse_id && r.ordinal === ordinal);
  for (const k of ['sku','name','location']) text(r[k]);
  valid(typeof r.delta === 'number' && Number.isSafeInteger(r.delta) && r.delta !== 0);
  valid(d.kind === 'PW' ? r.delta > 0 : r.delta < 0); integer(r.quantity, true);
  valid(BigInt(r.quantity) === BigInt(Math.abs(r.delta)));
  for (const k of ['bin_movement_id','layer_movement_id','stocktake_line_id','stocktake_posting_id','lot_id','layer_id']) if (r[k] !== null) identifier(r[k]);
  valid(r.source_index === null || typeof r.source_index === 'number' && Number.isSafeInteger(r.source_index) && r.source_index >= 0);
  if (d.wms_enabled) {
    valid(r.bin_movement_id === null && r.source_index !== null);
    valid(['layer_movement_id','stocktake_line_id','stocktake_posting_id','lot_id','layer_id'].every(k => r[k] !== null));
  } else {
    valid(r.bin_movement_id !== null && ['layer_movement_id','source_index','stocktake_line_id','stocktake_posting_id','lot_id','layer_id'].every(k => r[k] === null));
    valid(costKeys.every(k => !Object.hasOwn(r, k)));
  }
  const present = costKeys.filter(k => Object.hasOwn(r, k)).length;
  valid(present === 0 || present === costKeys.length); valid(!values || present === costKeys.length);
  if (present) {
    valid(typeof r.currency === 'string' && /^[A-Z]{3}$/.test(r.currency));
    valid(typeof r.exponent === 'number' && Number.isInteger(r.exponent) && r.exponent >= 0 && r.exponent <= 6);
    valid((r.unit_cost_minor === null) === (r.value_minor === null));
    if (r.unit_cost_minor !== null) {
      integer(r.unit_cost_minor); integer(r.value_minor);
      valid(BigInt(r.value_minor) === BigInt(r.quantity) * BigInt(r.unit_cost_minor));
    }
  }
  const q: CatalogStockCountPublicRow = { id: input.id, ordinal: input.ordinal, document_id: input.document_id,
    warehouse_id: input.warehouse_id, product_id: input.product_id, sku: input.sku, name: input.name, location: input.location,
    delta: input.delta, quantity: input.quantity, bin_movement_id: input.bin_movement_id, layer_movement_id: input.layer_movement_id,
    source_index: input.source_index, stocktake_line_id: input.stocktake_line_id, stocktake_posting_id: input.stocktake_posting_id,
    lot_id: input.lot_id, layer_id: input.layer_id };
  if (!values) return q;
  return { ...q, cost_state: r.unit_cost_minor === null ? 'unknown' : 'known',
    unit_cost_minor: r.unit_cost_minor as string | null, value_minor: r.value_minor as string | null,
    currency: r.currency as string, exponent: r.exponent as number };
}
function valuation(d: CatalogStockCountPublicDocument, rows: ValueRow[]): CatalogStockCountExportValuation {
  type Sums = { currency: string; exponent: number; known: bigint; zero: bigint; unknown: bigint; value: bigint };
  const sums = new Map<string, Sums>();
  for (const r of rows) {
    const key = `${r.currency}:${r.exponent}`;
    let b = sums.get(key); if (!b) { b = { currency: r.currency, exponent: r.exponent, known: 0n, zero: 0n, unknown: 0n, value: 0n }; sums.set(key, b); }
    if (r.unit_cost_minor === null) b.unknown += BigInt(r.quantity);
    else { b.known += BigInt(r.quantity); b.value += BigInt(r.value_minor!); if (r.unit_cost_minor === '0') b.zero += BigInt(r.quantity); }
  }
  const buckets = [...sums.values()].sort((a, b) => a.currency < b.currency ? -1 : a.currency > b.currency ? 1 : a.exponent - b.exponent)
    .map(b => ({ currency: b.currency, exponent: b.exponent, known_quantity: String(b.known), zero_cost_quantity: String(b.zero),
      unknown_quantity: String(b.unknown), known_value_minor: String(b.value), signed_known_value_minor: String(d.kind === 'RW' ? -b.value : b.value) }));
  valid(buckets.reduce((n, b) => n + BigInt(b.known_quantity) + BigInt(b.unknown_quantity), 0n) === BigInt(d.quantity));
  return { state: buckets.some(b => b.unknown_quantity !== '0') ? 'partial_unknown' : 'complete', physical_quantity: d.quantity, buckets };
}
function collector() {
  const chunks: string[] = []; let bytes = 0;
  return { append(s: string) { bytes += Buffer.byteLength(s, 'utf8'); ensure(bytes <= CATALOG_STOCK_COUNT_EXPORT_LIMITS.response_bytes, 413, 'Pełny eksport COUNT przekracza limit'); chunks.push(s); },
    content() { return chunks.join(''); } };
}
const numericColumns = new Set(['year','sequence','row_count','quantity','ordinal','delta','source_index','unit_cost_minor','value_minor','exponent',
  'known_quantity','zero_cost_quantity','unknown_quantity','known_value_minor','signed_known_value_minor']);
function csvCell(value: Cell, numeric = false): string {
  if (value === null || value === undefined) return '""';
  let v = String(value);
  if (numeric) valid(/^-?(0|[1-9][0-9]*)$/.test(v));
  else if (typeof value === 'string' && /^[\s]*[=+\-@\t\r\n]/u.test(v)) v = "'" + v;
  return '"' + v.replaceAll('"', '""') + '"';
}
function csv(d: CatalogStockCountPublicDocument, rows: Array<CatalogStockCountPublicRow | ValueRow>, state: CatalogStockCountExport['value_state'], v?: CatalogStockCountExportValuation) {
  const columns: readonly string[] = [...CATALOG_STOCK_COUNT_CSV_COLUMNS, ...(v ? CATALOG_STOCK_COUNT_CSV_VALUE_COLUMNS : [])];
  const out = collector(); out.append(columns.map(k => csvCell(k)).join(',') + '\r\n');
  const common = { document_id: d.id, receipt_id: d.receipt_id, source_id: d.source_id, execution_id: d.execution_id,
    protocol: d.protocol, number: d.number, kind: d.kind, series_id: d.series_id, year: d.year, sequence: d.sequence,
    created_at: d.created_at, warehouse_id: d.warehouse_id, wms_enabled: d.wms_enabled, value_state: state };
  const append = (r: RecordCells) => out.append(columns.map(k => csvCell(r[k], numericColumns.has(k))).join(',') + '\r\n');
  append({ ...common, record_type: 'document', warehouse_name: d.warehouse.name, warehouse_code: d.warehouse.code, row_count: d.row_count, quantity: d.quantity });
  if (v) for (const b of v.buckets) append({ ...common, ...b, record_type: 'valuation', quantity: String(BigInt(b.known_quantity) + BigInt(b.unknown_quantity)) });
  for (const r of rows) append({ ...common, ...r, record_type: 'row', row_id: r.id });
  return out.content();
}
function xmlText(v: Cell) {
  // XML parsers normalize literal CR/CRLF. A character reference retains the
  // exact recorded text instead of silently replacing CR with LF.
  return String(v).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;').replaceAll('\r', '&#13;');
}
function element(name: string, value: Cell): string {
  return value === null || value === undefined ? `<${name} nil="true"/>` : `<${name}>${xmlText(value)}</${name}>`;
}
function xml(d: CatalogStockCountPublicDocument, rows: Array<CatalogStockCountPublicRow | ValueRow>, v?: CatalogStockCountExportValuation) {
  const out = collector(); out.append('<?xml version="1.0" encoding="UTF-8"?>\n<count_document version="1"><document>');
  for (const k of headKeys) {
    if (k === 'warehouse') { out.append('<warehouse>'); for (const field of ['id','name','code'] as const) out.append(element(field, d.warehouse[field])); out.append('</warehouse>'); }
    else out.append(element(k, d[k as Exclude<keyof CatalogStockCountPublicDocument, 'warehouse'>]));
  }
  out.append('</document>');
  if (v) {
    out.append('<valuation>' + element('state', v.state) + element('physical_quantity', v.physical_quantity) + '<buckets>');
    for (const b of v.buckets) { out.append('<bucket>'); for (const [k, value] of Object.entries(b)) out.append(element(k, value)); out.append('</bucket>'); }
    out.append('</buckets></valuation>');
  }
  out.append('<rows>');
  for (const r of rows) { out.append('<row>'); for (const [k, value] of Object.entries(r)) out.append(element(k, value)); out.append('</row>'); }
  out.append('</rows></count_document>\n'); return out.content();
}

/** No authorization, query, file or mutation side effects. includeValues is a
 * trusted server projection decision, never a substitute for the caller's final IAM PIN. */
export function renderCatalogStockCountExport(
  document: CatalogStockCountPublicDocument,
  inputRows: readonly CatalogStockCountExportRow[],
  options: CatalogStockCountExportOptions,
): CatalogStockCountExport {
  ensure(options !== null && typeof options === 'object' && !Array.isArray(options), 422, 'Niepoprawne opcje eksportu COUNT');
  const opts = record(options);
  ensure(Object.keys(opts).length === 2 && ['format','includeValues'].every(k => Object.hasOwn(opts, k)), 422, 'Niepoprawne opcje eksportu COUNT');
  ensure((opts.format === 'csv' || opts.format === 'xml') && typeof opts.includeValues === 'boolean', 422, 'Niepoprawny format eksportu COUNT');
  const d = head(document);
  valid(Array.isArray(inputRows));
  ensure(inputRows.length <= CATALOG_STOCK_COUNT_EXPORT_LIMITS.rows, 413, 'Limit pełnego manifestu COUNT');
  valid(inputRows.length === d.row_count);
  const values = options.includeValues && d.wms_enabled;
  const rows = inputRows.map((r, i) => projectedRow(r, d, i, values));
  valid(new Set(rows.map(r => r.id)).size === rows.length);
  valid(new Set(rows.map(r => r.layer_movement_id ?? r.bin_movement_id)).size === rows.length);
  valid(rows.reduce((n, r) => n + BigInt(r.quantity), 0n) === BigInt(d.quantity));
  const v = values ? valuation(d, rows as ValueRow[]) : undefined;
  const state = !d.wms_enabled ? 'unavailable_off' : v?.state ?? 'not_requested';
  const reply: CatalogStockCountExport = { document: d, format: options.format,
    filename: `${d.kind}-count-${d.id}.${options.format}`,
    content_type: options.format === 'csv' ? 'text/csv; charset=utf-8' : 'application/xml; charset=utf-8',
    content: options.format === 'csv' ? csv(d, rows, state, v) : xml(d, rows, v), values_included: values,
    row_count: rows.length, value_state: state, ...(v ? { valuation: v } : {}) };
  // Escaping the content inside a JSON envelope can exceed the raw file size.
  // The future HTTP caller must also budget its final envelope after adding flags.
  ensure(Buffer.byteLength(JSON.stringify(reply), 'utf8') <= CATALOG_STOCK_COUNT_EXPORT_LIMITS.response_bytes,
    413, 'Pełna odpowiedź eksportu COUNT przekracza limit');
  return reply;
}
