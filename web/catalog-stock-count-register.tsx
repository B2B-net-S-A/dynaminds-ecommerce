import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from './api';
import type {
  CatalogStockCountPublicDocument as Document,
  CatalogStockCountPublicRow as Row,
  CatalogStockCountListReply,
  CatalogStockCountDetailReply,
} from '../server/catalog-stock-count-query';

type Props = { contextKey: string; available: boolean; readOnly: boolean; refresh?: unknown };
type Filters = { warehouse_id: string; kind: '' | 'PW' | 'RW'; protocol: '' | 'inventory_bulk' | 'stock_file' };
type List = { context: string; documents: Document[]; cursor: string | null; unavailable: boolean };
type Detail = { context: string; document: Document; rows: Row[]; cursor: string | null };
type ValueRow = Row & { cost_state?: 'known' | 'unknown'; unit_cost_minor?: string | null; value_minor?: string | null; currency?: string; exponent?: number };
type Bucket = { currency: string; exponent: number; known_quantity: string; zero_cost_quantity: string; unknown_quantity: string; known_value_minor: string; signed_known_value_minor: string };
type Valuation = { state: 'complete' | 'partial_unknown' | 'unavailable_off'; physical_quantity: string; buckets: Bucket[] };
type ValueDetail = { context: string; document: Document; rows: ValueRow[]; valuation: Valuation };
const emptyFilters: Filters = { warehouse_id: '', kind: '', protocol: '' };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const headKeys = ['id','receipt_id','source_id','execution_id','protocol','warehouse_id','warehouse','kind','number',
  'year','sequence','series_id','row_count','quantity','wms_enabled','created_at'];
const rowKeys = ['id','ordinal','document_id','warehouse_id','product_id','sku','name','location','delta','quantity',
  'bin_movement_id','layer_movement_id','source_index','stocktake_line_id','stocktake_posting_id','lot_id','layer_id'];
function expect(value: unknown, message = 'Odpowiedź rejestru COUNT jest niepełna lub ma inny zakres.'): asserts value {
  if (!value) throw new Error(message);
}
function object(v: unknown): Record<string, unknown> {
  expect(v !== null && typeof v === 'object' && !Array.isArray(v));
  return v as Record<string, unknown>;
}
function keys(v: Record<string, unknown>, allowed: string[]) {
  expect(Object.keys(v).length === allowed.length && Object.keys(v).every(k => allowed.includes(k)));
}
function id(v: unknown): asserts v is string { expect(typeof v === 'string' && uuid.test(v)); }
function quantity(v: unknown): asserts v is string {
  expect(typeof v === 'string' && /^[1-9][0-9]{0,18}$/.test(v) && BigInt(v) <= 9223372036854775807n);
}
function time(v: unknown): string {
  expect(typeof v === 'string');
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(?:Z|\+00:00)$/.exec(v);
  expect(match && Number.isFinite(Date.parse(v)));
  return match[1] + '.' + (match[2] ?? '').padEnd(6, '0');
}
function cursor(v: unknown): asserts v is string | null {
  expect(v === null || typeof v === 'string' && v.length <= 4096 && /^[A-Za-z0-9_-]+$/.test(v));
}
function document(v: unknown): Document {
  const d = object(v); keys(d, headKeys);
  for (const key of ['id','receipt_id','source_id','execution_id','warehouse_id','series_id']) id(d[key]);
  const wh = object(d.warehouse); keys(wh, ['id','name','code']); id(wh.id);
  expect(wh.id === d.warehouse_id && typeof wh.name === 'string' && typeof wh.code === 'string');
  expect(d.protocol === 'inventory_bulk' || d.protocol === 'stock_file');
  expect(d.kind === 'PW' || d.kind === 'RW');
  expect(typeof d.number === 'string' && d.number.length > 0);
  expect(Number.isInteger(d.year) && Number(d.year) >= 1 && Number(d.year) <= 9999);
  quantity(d.sequence); quantity(d.quantity); time(d.created_at);
  expect(d.number.endsWith(`/${d.year}/${d.sequence.padStart(6, '0')}`));
  expect(Number.isInteger(d.row_count) && Number(d.row_count) >= 1 && Number(d.row_count) <= 10000);
  expect(typeof d.wms_enabled === 'boolean');
  return d as unknown as Document;
}
function row(v: unknown, d: Document, ordinal: number): Row {
  const r = object(v); keys(r, rowKeys);
  for (const key of ['id','document_id','warehouse_id','product_id']) id(r[key]);
  expect(r.document_id === d.id && r.warehouse_id === d.warehouse_id && r.ordinal === ordinal);
  expect(['sku','name','location'].every(k => typeof r[k] === 'string'));
  expect(typeof r.delta === 'number' && Number.isSafeInteger(r.delta) && r.delta !== 0);
  expect(d.kind === 'PW' ? r.delta > 0 : r.delta < 0);
  quantity(r.quantity); expect(BigInt(r.quantity) === BigInt(Math.abs(r.delta)));
  for (const key of ['bin_movement_id','layer_movement_id','stocktake_line_id','stocktake_posting_id','lot_id','layer_id']) {
    if (r[key] !== null) id(r[key]);
  }
  expect(r.source_index === null || typeof r.source_index === 'number' && Number.isSafeInteger(r.source_index) && r.source_index >= 0);
  if (d.wms_enabled) {
    expect(r.bin_movement_id === null && r.source_index !== null);
    expect(['layer_movement_id','stocktake_line_id','stocktake_posting_id','lot_id','layer_id'].every(k => r[k] !== null));
  } else {
    expect(r.bin_movement_id !== null);
    expect(['layer_movement_id','source_index','stocktake_line_id','stocktake_posting_id','lot_id','layer_id'].every(k => r[k] === null));
  }
  return r as unknown as Row;
}
function context(key: string, readOnly: boolean) {
  const parts = key.split(':');
  expect(parts.length === 4 && uuid.test(parts[0]) && uuid.test(parts[1]) && ['admin','operator','viewer'].includes(parts[2])
    && parts[3] === String(readOnly), 'Brak aktualnego kontekstu konta i magazynu.');
  return { tenant: parts[0], user: parts[1], role: parts[2] };
}
function flags(v: Record<string, unknown>, key: string, readOnly: boolean) {
  const c = context(key, readOnly);
  expect(typeof v.available === 'boolean' && v.read_only === readOnly && v.current_role === c.role
    && v.can_read === true && v.can_read_value === false && v.value_state === 'not_projected');
  time(v.snapshot_at);
}
function listReply(raw: unknown, key: string, readOnly: boolean, filters: Filters, previous?: List): List {
  const v = object(raw); keys(v, ['available','read_only','can_read','can_read_value','value_state','current_role','data','meta','snapshot_at']);
  flags(v, key, readOnly); expect(Array.isArray(v.data) && v.data.length <= 50);
  const meta = object(v.meta); keys(meta, ['cursor','limit']); cursor(meta.cursor); expect(meta.limit === 50);
  expect(v.available || v.data.length === 0 && meta.cursor === null);
  expect(meta.cursor === null || v.data.length === 50);
  const page = v.data.map(document), all = [...(previous?.documents ?? []), ...page];
  expect(new Set(all.map(d => d.id)).size === all.length);
  for (let i = 0; i < all.length; i++) {
    const d = all[i];
    expect(!filters.warehouse_id || d.warehouse_id === filters.warehouse_id);
    expect(!filters.kind || d.kind === filters.kind); expect(!filters.protocol || d.protocol === filters.protocol);
    if (i) { const p = all[i - 1]; expect(time(p.created_at) > time(d.created_at) || time(p.created_at) === time(d.created_at) && p.id > d.id); }
  }
  expect(!previous || meta.cursor === null || meta.cursor !== previous.cursor);
  return { context: key, documents: all, cursor: meta.cursor, unavailable: !v.available };
}
function detailReply(raw: unknown, key: string, readOnly: boolean, selected: Document, previous?: Detail): Detail {
  const v = object(raw); keys(v, ['available','read_only','can_read','can_read_value','value_state','current_role','document','data','meta','snapshot_at']);
  flags(v, key, readOnly); expect(v.available === true);
  const d = document(v.document);
  expect(headKeys.every(k => k === 'warehouse'
    ? d.warehouse.id === selected.warehouse.id && d.warehouse.name === selected.warehouse.name && d.warehouse.code === selected.warehouse.code
    : d[k as keyof Document] === selected[k as keyof Document]), 'Nagłówek dokumentu zmienił się między odczytami.');
  const meta = object(v.meta); keys(meta, ['cursor','limit','total']); cursor(meta.cursor);
  expect(meta.limit === 50 && meta.total === d.row_count && Array.isArray(v.data) && v.data.length > 0 && v.data.length <= 50);
  const offset = previous?.rows.length ?? 0;
  const page = v.data.map((r, i) => row(r, d, offset + i)), rows = [...(previous?.rows ?? []), ...page];
  expect(new Set(rows.map(r => r.id)).size === rows.length);
  expect(new Set(rows.map(r => r.layer_movement_id ?? r.bin_movement_id)).size === rows.length);
  expect(rows.length <= d.row_count && (meta.cursor === null ? rows.length === d.row_count : page.length === 50 && rows.length < d.row_count));
  expect(!previous || meta.cursor === null || meta.cursor !== previous.cursor);
  const sum = rows.reduce((n, r) => n + BigInt(r.quantity), 0n);
  expect(meta.cursor === null ? sum === BigInt(d.quantity) : sum < BigInt(d.quantity));
  return { context: key, document: d, rows, cursor: meta.cursor };
}
function sameHead(a: Document, b: Document) {
  expect(headKeys.every(k => k === 'warehouse' ? a.warehouse.id === b.warehouse.id && a.warehouse.name === b.warehouse.name
    && a.warehouse.code === b.warehouse.code : a[k as keyof Document] === b[k as keyof Document]), 'Odczytano inny dokument pomiaru.');
}
function decimal(v: unknown, signed = false): asserts v is string {
  expect(typeof v === 'string' && (signed ? /^(0|-?[1-9][0-9]*)$/ : /^(0|[1-9][0-9]*)$/).test(v) && v.length <= 40);
}
const costKeys = ['cost_state','unit_cost_minor','value_minor','currency','exponent'];
function valuePage(raw: unknown, key: string, readOnly: boolean, selected: Document, offset: number, limit = 50) {
  const v = object(raw); keys(v, ['available','read_only','can_read','can_read_value','value_state','current_role','document','valuation','data','meta','snapshot_at']);
  const c = context(key, readOnly);
  expect(v.available === true && v.read_only === readOnly && v.current_role === c.role && v.can_read === true
    && v.can_read_value === true, 'Utracono dostęp do wyceny dokumentu.'); time(v.snapshot_at);
  const d = document(v.document); sameHead(d, selected);
  const summary = object(v.valuation); keys(summary, ['state','physical_quantity','buckets']);
  expect(summary.physical_quantity === d.quantity && Array.isArray(summary.buckets) && summary.buckets.length <= d.row_count);
  expect(d.wms_enabled ? ['complete','partial_unknown'].includes(String(summary.state)) : summary.state === 'unavailable_off');
  expect(v.value_state === summary.state);
  const buckets = summary.buckets.map(rawBucket => {
    const b = object(rawBucket); keys(b, ['currency','exponent','known_quantity','zero_cost_quantity','unknown_quantity','known_value_minor','signed_known_value_minor']);
    expect(typeof b.currency === 'string' && /^[A-Z]{3}$/.test(b.currency) && Number.isInteger(b.exponent) && Number(b.exponent) >= 0 && Number(b.exponent) <= 6);
    for (const k of ['known_quantity','zero_cost_quantity','unknown_quantity','known_value_minor']) decimal(b[k]); decimal(b.signed_known_value_minor, true);
    expect(BigInt(b.zero_cost_quantity as string) <= BigInt(b.known_quantity as string));
    expect(BigInt(b.signed_known_value_minor as string) === (d.kind === 'RW' ? -1n : 1n) * BigInt(b.known_value_minor as string));
    return { currency: b.currency, exponent: b.exponent, known_quantity: b.known_quantity, zero_cost_quantity: b.zero_cost_quantity,
      unknown_quantity: b.unknown_quantity, known_value_minor: b.known_value_minor, signed_known_value_minor: b.signed_known_value_minor } as Bucket;
  });
  expect(new Set(buckets.map(b => b.currency + ':' + b.exponent)).size === buckets.length);
  expect(!d.wms_enabled ? buckets.length === 0 : buckets.length > 0 && buckets.reduce((n, b) => n + BigInt(b.known_quantity) + BigInt(b.unknown_quantity), 0n) === BigInt(d.quantity));
  expect(!d.wms_enabled || (buckets.some(b => b.unknown_quantity !== '0') ? 'partial_unknown' : 'complete') === summary.state);
  const meta = object(v.meta); keys(meta, ['cursor','limit','total']); cursor(meta.cursor);
  expect(meta.limit === limit && meta.total === d.row_count && Array.isArray(v.data) && v.data.length > 0 && v.data.length <= limit);
  const rows: ValueRow[] = v.data.map((rawRow, n) => {
    const r = object(rawRow); keys(r, d.wms_enabled ? [...rowKeys, ...costKeys] : rowKeys);
    const base = Object.fromEntries(rowKeys.map(k => [k, r[k]])); const quantityRow = row(base, d, offset + n);
    if (!d.wms_enabled) return quantityRow;
    expect(r.cost_state === 'known' || r.cost_state === 'unknown');
    expect(typeof r.currency === 'string' && /^[A-Z]{3}$/.test(r.currency) && Number.isInteger(r.exponent) && Number(r.exponent) >= 0 && Number(r.exponent) <= 6);
    if (r.cost_state === 'unknown') expect(r.unit_cost_minor === null && r.value_minor === null);
    else { decimal(r.unit_cost_minor); decimal(r.value_minor); expect(BigInt(r.unit_cost_minor) <= 9223372036854775807n
      && BigInt(r.value_minor) <= 9223372036854775807n && BigInt(r.value_minor) === BigInt(quantityRow.quantity) * BigInt(r.unit_cost_minor)); }
    return { ...quantityRow, cost_state: r.cost_state, unit_cost_minor: r.unit_cost_minor, value_minor: r.value_minor,
      currency: r.currency, exponent: r.exponent } as ValueRow;
  });
  return { document: d, rows, cursor: meta.cursor, valuation: { state: summary.state, physical_quantity: summary.physical_quantity, buckets } as Valuation };
}
function completeValue(d: Document, rows: ValueRow[], value: Valuation) {
  expect(rows.length === d.row_count && new Set(rows.map(r => r.id)).size === rows.length
    && new Set(rows.map(r => r.layer_movement_id ?? r.bin_movement_id)).size === rows.length);
  expect(rows.reduce((n, r) => n + BigInt(r.quantity), 0n) === BigInt(d.quantity));
  if (!d.wms_enabled) return;
  const totals = new Map<string, { known: bigint; zero: bigint; unknown: bigint; value: bigint }>();
  for (const r of rows) {
    const k = r.currency + ':' + r.exponent, b = totals.get(k) ?? { known: 0n, zero: 0n, unknown: 0n, value: 0n }, q = BigInt(r.quantity);
    if (r.cost_state === 'unknown') b.unknown += q;
    else { b.known += q; if (r.unit_cost_minor === '0') b.zero += q; b.value += BigInt(r.value_minor!); } totals.set(k, b);
  }
  expect(totals.size === value.buckets.length);
  for (const b of value.buckets) { const actual = totals.get(b.currency + ':' + b.exponent); expect(actual
    && actual.known === BigInt(b.known_quantity) && actual.zero === BigInt(b.zero_cost_quantity)
    && actual.unknown === BigInt(b.unknown_quantity) && actual.value === BigInt(b.known_value_minor)); }
}
function moneyAmount(value: string, currency: string, exponent: number) {
  const n = BigInt(value), absolute = n < 0n ? -n : n, divisor = 10n ** BigInt(exponent);
  return (n < 0n ? '−' : '') + (absolute / divisor).toLocaleString('pl-PL')
    + (exponent ? ',' + String(absolute % divisor).padStart(exponent, '0') : '') + ' ' + currency;
}
function BufferlessBytes(value: unknown) { return new TextEncoder().encode(JSON.stringify(value)).byteLength; }
function validateFile(content: string, format: 'csv' | 'xml', d: Document, values: boolean, expectedValue?: ValueDetail) {
  const forbidden = ['nonce','proof','frame','request','snapshot','admission_id','actor_id','api_key_id','scope_hash','rows_sha256','input_hash'];
  let physical: Record<string, string>[];
  const baseColumns = ['record_type','document_id','receipt_id','source_id','execution_id','protocol','number','kind','series_id','year','sequence',
    'created_at','warehouse_id','warehouse_name','warehouse_code','wms_enabled','row_count','quantity','value_state','ordinal','row_id','product_id','sku','name',
    'location','delta','bin_movement_id','layer_movement_id','source_index','stocktake_line_id','stocktake_posting_id','lot_id','layer_id'];
  const financialColumns = ['cost_state','unit_cost_minor','value_minor','currency','exponent','known_quantity','zero_cost_quantity','unknown_quantity','known_value_minor','signed_known_value_minor'];
  const csvText = (v: unknown) => v == null ? '' : typeof v === 'string' && /^[\s]*[=+\-@\t\r\n]/u.test(v) ? "'" + v : String(v);
  const literal = (v: unknown) => v == null ? '' : String(v);
  if (format === 'csv') {
    const records: string[][] = []; let fields: string[] = [], field = '', quoted = false;
    for (let i = 0; i < content.length; i++) {
      const c = content[i];
      if (quoted) { if (c === '"' && content[i + 1] === '"') { field += '"'; i++; } else if (c === '"') quoted = false; else field += c; }
      else if (c === '"') { expect(!field); quoted = true; }
      else if (c === ',') { fields.push(field); field = ''; }
      else if (c === '\r' && content[i + 1] === '\n') { fields.push(field); records.push(fields); fields = []; field = ''; i++; }
      else field += c;
    }
    expect(!quoted && !fields.length && !field); const columns = records.shift(); expect(columns);
    expect(new Set(columns).size === columns.length && !columns.some(k => forbidden.includes(k)));
    expect(JSON.stringify(columns) === JSON.stringify([...baseColumns, ...(values ? financialColumns : [])]));
    if (!values) expect(!columns.some(k => costKeys.includes(k) || ['known_value_minor','signed_known_value_minor','known_quantity','zero_cost_quantity','unknown_quantity'].includes(k)));
    const all = records.map(r => { expect(r.length === columns.length); return Object.fromEntries(columns.map((k, i) => [k, r[i]])); });
    const heads = all.filter(r => r.record_type === 'document'); expect(heads.length === 1 && heads[0].document_id === d.id
      && heads[0].number === d.number && heads[0].quantity === d.quantity && heads[0].row_count === String(d.row_count));
    expect(all.every(r => r.document_id === d.id && r.receipt_id === d.receipt_id && r.source_id === d.source_id
      && r.execution_id === d.execution_id && r.warehouse_id === d.warehouse_id && r.kind === d.kind));
    for (const r of all) for (const k of ['protocol','number','series_id','year','sequence','created_at','wms_enabled'] as const)
      expect(r[k] === literal(d[k]));
    expect(heads[0].warehouse_name === csvText(d.warehouse.name) && heads[0].warehouse_code === csvText(d.warehouse.code));
    expect(all.every(r => ['document','valuation','row'].includes(r.record_type)));
    const buckets = all.filter(r => r.record_type === 'valuation'); expect(buckets.length === (values ? expectedValue?.valuation.buckets.length : 0));
    if (values) { expect(expectedValue); buckets.forEach((b, i) => {
      const expected = expectedValue.valuation.buckets[i];
      for (const k of Object.keys(expected) as Array<keyof Bucket>) expect(b[k] === String(expected[k]));
      expect(b.quantity === String(BigInt(expected.known_quantity) + BigInt(expected.unknown_quantity)));
    }); }
    physical = all.filter(r => r.record_type === 'row').map(r => ({ ...r, id: r.row_id }));
  } else {
    expect(!/<!DOCTYPE|<!ENTITY/i.test(content)); const parsed = new DOMParser().parseFromString(content, 'application/xml');
    expect(!parsed.querySelector('parsererror') && parsed.documentElement.tagName === 'count_document');
    const root = parsed.documentElement; expect(root.getAttribute('version') === '1');
    expect(JSON.stringify([...root.children].map(e => e.tagName)) === JSON.stringify(values ? ['document','valuation','rows'] : ['document','rows']));
    expect(!forbidden.some(k => parsed.getElementsByTagName(k).length));
    if (!values) expect(![...costKeys,'known_value_minor','signed_known_value_minor'].some(k => parsed.getElementsByTagName(k).length));
    const scalar = (element: Element) => { expect(new Set([...element.children].map(e => e.tagName)).size === element.children.length);
      return Object.fromEntries([...element.children].map(c => { expect(c.children.length === 0); return [c.tagName, c.getAttribute('nil') === 'true' ? '' : c.textContent ?? '']; })); };
    const heads = [...root.children].filter(e => e.tagName === 'document'); expect(heads.length === 1);
    expect(JSON.stringify([...heads[0].children].map(e => e.tagName)) === JSON.stringify(headKeys));
    const h = Object.fromEntries([...heads[0].children].filter(e => e.tagName !== 'warehouse').map(e => [e.tagName, e.textContent ?? '']));
    const warehouses = [...heads[0].children].filter(e => e.tagName === 'warehouse'); expect(warehouses.length === 1);
    const wh = scalar(warehouses[0]); expect(Object.keys(wh).length === 3 && wh.id === d.warehouse.id && wh.name === d.warehouse.name && wh.code === d.warehouse.code);
    expect(h.id === d.id && h.receipt_id === d.receipt_id && h.source_id === d.source_id
      && h.execution_id === d.execution_id && h.kind === d.kind && h.number === d.number && h.quantity === d.quantity && h.row_count === String(d.row_count));
    for (const k of headKeys.filter(k => k !== 'warehouse')) expect(h[k] === literal(d[k as keyof Document]));
    if (values) { expect(expectedValue); const v = [...root.children].find(e => e.tagName === 'valuation'); expect(v);
      expect(JSON.stringify([...v.children].map(e => e.tagName)) === JSON.stringify(['state','physical_quantity','buckets']));
      expect(v.children[0].textContent === expectedValue.valuation.state && v.children[1].textContent === d.quantity);
      const buckets = [...v.children[2].children]; expect(buckets.length === expectedValue.valuation.buckets.length);
      buckets.forEach((b, i) => { expect(b.tagName === 'bucket'); const actual = scalar(b), expected = expectedValue.valuation.buckets[i];
        expect(Object.keys(actual).length === Object.keys(expected).length); for (const k of Object.keys(expected) as Array<keyof Bucket>) expect(actual[k] === String(expected[k])); });
    }
    const containers = [...root.children].filter(e => e.tagName === 'rows'); expect(containers.length === 1);
    physical = [...containers[0].children].map(e => { expect(e.tagName === 'row'); return scalar(e); });
  }
  expect(physical.length === d.row_count && new Set(physical.map(r => r.id)).size === physical.length);
  let sum = 0n;
  physical.forEach((r, ordinal) => { id(r.id); expect(r.ordinal === String(ordinal) && r.document_id === d.id && r.warehouse_id === d.warehouse_id);
    decimal(r.quantity); decimal(r.delta, true); expect(BigInt(r.quantity) > 0n && BigInt(r.delta) === (d.kind === 'RW' ? -1n : 1n) * BigInt(r.quantity)); sum += BigInt(r.quantity);
    if (format === 'xml') expect(Object.keys(r).length === rowKeys.length + (values ? costKeys.length : 0)
      && Object.keys(r).every(k => [...rowKeys, ...(values ? costKeys : [])].includes(k)));
    if (values) { const expected = expectedValue?.rows[ordinal]; expect(expected && r.id === expected.id);
      for (const k of [...rowKeys, ...costKeys]) {
        const value = expected[k as keyof ValueRow];
        const text = format === 'csv' && ['sku','name','location'].includes(k) ? csvText(value) : literal(value);
        expect(r[k] === text);
      }
    }
  });
  expect(sum === BigInt(d.quantity), 'Pobrany plik nie zawiera całego dokumentu.');
}
function human(error: unknown) {
  if (error instanceof ApiError && error.status === 503) return 'Rejestr COUNT jest chwilowo niedostępny lub jego moduł jest niekompletny.';
  return error instanceof Error ? error.message : 'Nie udało się odczytać rejestru COUNT.';
}
function amount(value: string, sign?: 'PW' | 'RW') {
  return (sign === 'PW' ? '+' : sign === 'RW' ? '−' : '') + BigInt(value).toLocaleString('pl-PL');
}
function date(value: string) { return new Date(value).toLocaleString('pl-PL'); }

/** Immutable COUNT history. Financial reads are explicit; there are no stock writes. */
export function CatalogStockCountRegister(props: Props) {
  const latest = useRef(props); latest.current = props;
  const mounted = useRef(false), generation = useRef(0), serial = useRef(0);
  const listFlight = useRef<number | null>(null), detailFlight = useRef<number | null>(null), valueFlight = useRef<number | null>(null);
  const downloadUrl = useRef<string | null>(null);
  const [draft, setDraft] = useState<Filters>(emptyFilters), [filters, setFilters] = useState<Filters>(emptyFilters);
  const [list, setList] = useState<List | null>(null), [detail, setDetail] = useState<Detail | null>(null);
  const [listBusy, setListBusy] = useState(false), [detailBusy, setDetailBusy] = useState(false);
  const [listError, setListError] = useState(''), [detailError, setDetailError] = useState('');
  const [values, setValues] = useState<ValueDetail | null>(null), [valueBusy, setValueBusy] = useState(false);
  const [format, setFormat] = useState<'csv' | 'xml'>('csv'), [includeValues, setIncludeValues] = useState(false), [downloaded, setDownloaded] = useState('');
  const contextMatches = props.contextKey.split(':').at(-1) === String(props.readOnly);
  const visibleList = list?.context === props.contextKey && props.available && contextMatches ? list : null;
  const visibleDetail = detail?.context === props.contextKey && props.available && contextMatches ? detail : null;
  const visibleValues = values?.context === props.contextKey && values.document.id === visibleDetail?.document.id && props.available && contextMatches ? values : null;
  const reading = listBusy || detailBusy || valueBusy;
  function ticket() {
    const { contextKey: key, available, readOnly, refresh } = latest.current;
    expect(available, 'Rejestr COUNT nie jest dostępny.'); context(key, readOnly);
    const g = generation.current;
    return { key, readOnly, live: () => mounted.current && g === generation.current && latest.current.contextKey === key
      && latest.current.readOnly === readOnly && Object.is(latest.current.refresh, refresh) && latest.current.available };
  }
  async function actor(t: ReturnType<typeof ticket>) {
    const reply = object(await api<unknown>('/auth/me')); if (!t.live()) return false;
    const user = object(reply.user), c = context(t.key, t.readOnly);
    expect(user.id === c.user && user.tenant_id === c.tenant && user.role === c.role, 'Konto lub uprawnienia zmieniły się. Odśwież kontekst.');
    return true;
  }
  function clearValues() { setValues(null); setIncludeValues(false); setDownloaded(''); if (downloadUrl.current) URL.revokeObjectURL(downloadUrl.current); downloadUrl.current = null; }
  function purge() { setList(null); setDetail(null); clearValues(); }
  async function loadList(f: Filters, previous?: List) {
    if (listFlight.current !== null || detailFlight.current !== null || valueFlight.current !== null) return;
    const n = ++serial.current; listFlight.current = n; setListBusy(true); setListError('');
    clearValues();
    let t: ReturnType<typeof ticket> | undefined;
    try {
      t = ticket(); if (!(await actor(t))) return;
      const query = new URLSearchParams({ limit: '50' });
      if (f.warehouse_id) query.set('warehouse_id', f.warehouse_id);
      if (f.kind) query.set('kind', f.kind); if (f.protocol) query.set('protocol', f.protocol);
      if (previous?.cursor) query.set('cursor', previous.cursor);
      const raw = await api<CatalogStockCountListReply>('/catalog-stock-control/count-documents?' + query);
      if (!t.live() || !(await actor(t)) || !t.live()) return;
      setList(listReply(raw, t.key, t.readOnly, f, previous));
    } catch (e) { if (!t || t.live()) { purge(); setListError(human(e)); } }
    finally { if (listFlight.current === n) { listFlight.current = null; setListBusy(false); } }
  }
  async function loadDetail(d: Document, previous?: Detail) {
    if (detailFlight.current !== null || listFlight.current !== null || valueFlight.current !== null) return;
    const n = ++serial.current; detailFlight.current = n; setDetailBusy(true); setDetailError('');
    if (!previous) { setDetail(null); clearValues(); }
    let t: ReturnType<typeof ticket> | undefined;
    try {
      t = ticket(); if (!(await actor(t))) return;
      const query = new URLSearchParams({ limit: '50' }); if (previous?.cursor) query.set('cursor', previous.cursor);
      const raw = await api<CatalogStockCountDetailReply>(`/catalog-stock-control/count-documents/${d.id}?${query}`);
      if (!t.live() || !(await actor(t)) || !t.live()) return;
      setDetail(detailReply(raw, t.key, t.readOnly, d, previous));
    } catch (e) { if (!t || t.live()) { purge(); setDetailError(human(e)); } }
    finally { if (detailFlight.current === n) { detailFlight.current = null; setDetailBusy(false); } }
  }
  async function readValue(d: Document) {
    if (listFlight.current !== null || detailFlight.current !== null || valueFlight.current !== null) return;
    const n = ++serial.current; valueFlight.current = n; setValueBusy(true); setDetailError(''); clearValues();
    let t: ReturnType<typeof ticket> | undefined;
    try {
      t = ticket(); if (!(await actor(t))) return;
      const rows: ValueRow[] = [], seen = new Set<string>(); let next: string | null = null, valuation: Valuation | undefined;
      do {
        const query = new URLSearchParams({ limit: '50' }); if (next) query.set('cursor', next);
        const raw = await api<unknown>(`/catalog-stock-control/count-documents/${d.id}/value?${query}`);
        if (!t.live() || !(await actor(t)) || !t.live()) return;
        const page = valuePage(raw, t.key, t.readOnly, d, rows.length);
        if (valuation) expect(JSON.stringify(page.valuation) === JSON.stringify(valuation), 'Wycena zmieniła się między stronami.');
        else valuation = page.valuation;
        rows.push(...page.rows); expect(rows.length <= d.row_count && BufferlessBytes(rows) <= 8388608);
        if (page.cursor) { expect(page.rows.length === 50 && rows.length < d.row_count && !seen.has(page.cursor)); seen.add(page.cursor); }
        else expect(rows.length === d.row_count); next = page.cursor;
      } while (next);
      expect(valuation); completeValue(d, rows, valuation);
      if (t.live()) setValues({ context: t.key, document: d, rows, valuation });
    } catch (e) { if (!t || t.live()) { clearValues(); if (!(e instanceof ApiError && e.status === 403)) purge(); setDetailError(human(e)); } }
    finally { if (valueFlight.current === n) { valueFlight.current = null; setValueBusy(false); } }
  }
  async function download(d: Document) {
    if (listFlight.current !== null || detailFlight.current !== null || valueFlight.current !== null) return;
    const n = ++serial.current; valueFlight.current = n; setValueBusy(true); setDetailError(''); setDownloaded('');
    let t: ReturnType<typeof ticket> | undefined;
    const requestedValues = includeValues, selectedFormat = format;
    if (!requestedValues) clearValues();
    try {
      t = ticket();
      const fresh = async () => {
        expect(t && t.live()); if (!(await actor(t))) throw Error('Kontekst odczytu został zmieniony.');
        const path = `/catalog-stock-control/count-documents/${d.id}${requestedValues ? '/value' : ''}?limit=1`;
        const raw = await api<unknown>(path); expect(t.live());
        if (!(await actor(t)) || !t.live()) throw Error('Kontekst odczytu został zmieniony.');
        if (requestedValues) { const page = valuePage(raw, t.key, t.readOnly, d, 0, 1);
          expect(visibleValues && JSON.stringify(page.valuation) === JSON.stringify(visibleValues.valuation)); }
        else { const v = object(raw); flags(v, t.key, t.readOnly); expect(v.available === true); sameHead(document(v.document), d); }
      };
      await fresh();
      const raw = object(await api<unknown>(`/catalog-stock-control/count-documents/${d.id}/export?${new URLSearchParams({ format: selectedFormat, include_values: String(requestedValues) })}`));
      expect(t.live()); const valued = requestedValues && d.wms_enabled;
      keys(raw, ['document','format','filename','content_type','content','values_included','row_count','value_state',
        ...(valued ? ['valuation'] : []), 'available','read_only','can_read','can_read_value','current_role','snapshot_at']);
      const c = context(t.key, t.readOnly); expect(raw.available === true && raw.read_only === t.readOnly && raw.current_role === c.role && raw.can_read === true
        && typeof raw.can_read_value === 'boolean' && (!requestedValues || raw.can_read_value === true)); time(raw.snapshot_at);
      sameHead(document(raw.document), d); expect(raw.format === selectedFormat && raw.filename === `${d.kind}-count-${d.id}.${selectedFormat}`
        && raw.content_type === (selectedFormat === 'csv' ? 'text/csv; charset=utf-8' : 'application/xml; charset=utf-8')
        && raw.row_count === d.row_count && raw.values_included === valued && typeof raw.content === 'string'
        && BufferlessBytes(raw) <= 8388608);
      expect(raw.value_state === (!d.wms_enabled ? 'unavailable_off' : valued ? visibleValues?.valuation.state : 'not_requested'));
      if (valued) expect(JSON.stringify(raw.valuation) === JSON.stringify(visibleValues?.valuation));
      validateFile(raw.content as string, selectedFormat, d, valued, visibleValues ?? undefined);
      if (!raw.can_read_value) clearValues();
      await fresh(); expect(t.live());
      const blob = new Blob([raw.content as string], { type: raw.content_type as string });
      const url = URL.createObjectURL(blob); downloadUrl.current = url;
      const anchor = globalThis.document.createElement('a'); anchor.href = url; anchor.download = raw.filename as string; anchor.click();
      URL.revokeObjectURL(url); downloadUrl.current = null; setDownloaded(`Pobrano cały dokument ${d.number} (${d.row_count} pozycji).`);
    } catch (e) { if (!t || t.live()) { clearValues(); if (!(e instanceof ApiError && e.status === 403)) purge(); setDetailError(human(e)); } }
    finally { if (valueFlight.current === n) { valueFlight.current = null; setValueBusy(false); } }
  }
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; generation.current++; if (downloadUrl.current) URL.revokeObjectURL(downloadUrl.current); };
  }, []);
  useEffect(() => {
    generation.current++; listFlight.current = null; detailFlight.current = null; valueFlight.current = null;
    purge(); setListError(''); setDetailError(''); setListBusy(false); setDetailBusy(false); setValueBusy(false);
    setDraft(emptyFilters); setFilters(emptyFilters);
    if (props.available) void loadList(emptyFilters);
    // Each request captures the canonical context and generation independently.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.contextKey, props.available, props.readOnly, props.refresh]);
  function apply() {
    if (listFlight.current !== null || detailFlight.current !== null || valueFlight.current !== null) return;
    const f = { ...draft, warehouse_id: draft.warehouse_id.trim().toLowerCase() };
    if (f.warehouse_id && !uuid.test(f.warehouse_id)) { setListError('Podaj poprawny UUID magazynu lub pozostaw pole puste.'); return; }
    generation.current++; purge(); setFilters(f); setDraft(f); setDetailError(''); void loadList(f);
  }
  if (!props.available) return <section className="card" aria-label="Rejestr dokumentów COUNT"><h3>Dokumenty pomiarów COUNT</h3><p>Rejestr dokumentów COUNT nie jest dostępny w tym środowisku.</p></section>;
  return <section className="card" aria-label="Rejestr dokumentów COUNT">
    <h3>Dokumenty pomiarów COUNT</h3>
    <p>Dokumenty PW i RW zapisane przy rozliczeniu pomiarów. Historia i eksport nie zmieniają ponownie zapasu. Historyczną wycenę można odczytać osobno, przy odpowiednich uprawnieniach.</p>
    {props.readOnly && <p>Środowisko działa w trybie tylko do odczytu.</p>}
    <form className="form-grid" onSubmit={e => { e.preventDefault(); apply(); }}>
      <label>Magazyn (UUID) <input value={draft.warehouse_id} onChange={e => setDraft({ ...draft, warehouse_id: e.target.value })} /></label>{' '}
      <label>Rodzaj <select value={draft.kind} onChange={e => setDraft({ ...draft, kind: e.target.value as Filters['kind'] })}>
        <option value="">PW i RW</option><option value="PW">PW — nadwyżka</option><option value="RW">RW — niedobór</option>
      </select></label>{' '}
      <label>Źródło <select value={draft.protocol} onChange={e => setDraft({ ...draft, protocol: e.target.value as Filters['protocol'] })}>
        <option value="">Wszystkie pomiary</option><option value="inventory_bulk">Edycja zbiorcza</option><option value="stock_file">Import pliku</option>
      </select></label>{' '}
      <button className="button primary" disabled={reading} type="submit">Pokaż</button>{' '}
      <button className="button" disabled={reading} type="button" onClick={() => { generation.current++; purge(); setDetailError(''); void loadList(filters); }}>Odśwież</button>
    </form>
    {listError && <p role="alert">{listError}</p>}
    {detailError && <p role="alert">{detailError}</p>}
    {listBusy && <p role="status">Ładowanie dokumentów…</p>}
    {visibleList?.unavailable && <p>Moduł dokumentów COUNT nie jest zainstalowany. Brak dostępnego rejestru.</p>}
    {visibleList && !visibleList.unavailable && visibleList.documents.length === 0 && <p>Brak dokumentów COUNT dla wybranych filtrów. Same przesunięcia lokalizacji nie tworzą PW/RW.</p>}
    {visibleList && visibleList.documents.length > 0 && <>
      <table><thead><tr><th>Numer / data</th><th>Magazyn</th><th>Źródło</th><th>Zmiana ilości</th><th>Wiersze</th><th>Odczyt</th></tr></thead>
        <tbody>{visibleList.documents.map(d => <tr key={d.id}>
          <td>{d.number}<br />{date(d.created_at)}</td><td>{d.warehouse.name} ({d.warehouse.code})</td>
          <td>{d.protocol === 'inventory_bulk' ? 'Edycja zbiorcza' : 'Import pliku'}</td>
          <td>{amount(d.quantity, d.kind)}</td><td>{d.row_count.toLocaleString('pl-PL')}</td>
          <td><button className="button" type="button" disabled={reading} onClick={() => void loadDetail(d)}>Wiersze {d.number}</button></td>
        </tr>)}</tbody></table>
      <p>Wczytano {visibleList.documents.length} dokumentów.{visibleList.cursor ? ' Dostępna jest następna strona.' : ' Koniec listy.'}</p>
      {visibleList.cursor && <button className="button" type="button" disabled={reading} onClick={() => void loadList(filters, visibleList)}>Więcej dokumentów (do 50)</button>}
    </>}
    {detailBusy && <p role="status">Ładowanie wierszy dokumentu…</p>}
    {visibleDetail && <section aria-label={`Wiersze ${visibleDetail.document.number}`}>
      <h4>{visibleDetail.document.number}</h4>
      <p>{visibleDetail.document.warehouse.name} · {visibleDetail.document.wms_enabled ? 'Pomiar partii WMS' : 'Pomiar ilości lokalizacji'} · {date(visibleDetail.document.created_at)}</p>
      <details><summary>Powiązanie z pomiarem</summary><p>Źródło: {visibleDetail.document.source_id}<br />Wykonanie: {visibleDetail.document.execution_id}<br />Potwierdzenie: {visibleDetail.document.receipt_id}</p></details>
      <table><thead><tr><th>Wiersz</th><th>Produkt / SKU</th><th>Lokalizacja</th><th>Zmiana ilości</th><th>Zapisany ruch</th></tr></thead>
        <tbody>{visibleDetail.rows.map(r => <tr key={r.id}><td>{r.ordinal + 1}</td><td>{r.name}<br />{r.sku}<br /><small>{r.product_id}</small></td>
          <td>{r.location}</td><td>{amount(r.quantity, visibleDetail.document.kind)}</td><td><small>{r.layer_movement_id ?? r.bin_movement_id}</small>
            {r.lot_id && <><br /><small>Partia: {r.lot_id}</small></>}</td></tr>)}</tbody></table>
      <p>Wczytano {visibleDetail.rows.length} z {visibleDetail.document.row_count} wierszy.
        {visibleDetail.cursor ? ' Manifest jest jeszcze niepełny.' : ` Pełny manifest: ${amount(visibleDetail.document.quantity, visibleDetail.document.kind)}.`}</p>
      {visibleDetail.cursor && <button className="button" type="button" disabled={reading} onClick={() => void loadDetail(visibleDetail.document, visibleDetail)}>Więcej wierszy (do 50)</button>}
      {props.contextKey.split(':')[2] === 'admin' && <button className="button" type="button" disabled={reading}
        onClick={() => void readValue(visibleDetail.document)}>Pokaż wycenę dokumentu</button>}
      {valueBusy && <p role="status">Sprawdzanie uprawnień i odczyt pełnego dokumentu…</p>}
      {visibleValues && <article className="notice" style={{ display: 'block', overflowX: 'auto' }} aria-label="Historyczna wycena dokumentu">
        <h4>Historyczna wycena {visibleValues.document.number}</h4>
        {visibleValues.valuation.state === 'unavailable_off' ? <p>Wycena niedostępna: pomiar wykonano bez partii WMS.</p> : <>
          {visibleValues.valuation.buckets.map(b => <p key={b.currency + ':' + b.exponent}>
            Zapisana wartość netto: {moneyAmount(b.signed_known_value_minor, b.currency, b.exponent)} · znany koszt: {BigInt(b.known_quantity).toLocaleString('pl-PL')} szt.
            {' '}· w tym koszt 0: {BigInt(b.zero_cost_quantity).toLocaleString('pl-PL')} szt. · koszt nieznany: {BigInt(b.unknown_quantity).toLocaleString('pl-PL')} szt.
          </p>)}
          <p>Wartość obejmuje wyłącznie pozycje ze znanym kosztem. Koszt nieznany pozostaje niewyceniony.</p>
          <table><thead><tr><th>Produkt / lokalizacja</th><th>Koszt jednostkowy netto</th><th>Wartość netto pozycji</th></tr></thead>
            <tbody>{visibleValues.rows.map(r => <tr key={r.id}><td>{r.name} · {r.location}</td>
              <td>{r.cost_state === 'unknown' ? 'Koszt nieznany' : moneyAmount(r.unit_cost_minor!, r.currency!, r.exponent!)}</td>
              <td>{r.cost_state === 'unknown' ? 'Niewyceniona' : moneyAmount(r.value_minor!, r.currency!, r.exponent!)}</td></tr>)}</tbody></table>
        </>}
      </article>}
      <div className="form-grid">
        <label>Format pliku <select disabled={reading} value={format} onChange={e => { setFormat(e.target.value as 'csv' | 'xml'); setDownloaded(''); }}>
          <option value="csv">CSV</option><option value="xml">XML</option></select></label>
        {visibleValues && <label><input type="checkbox" disabled={reading || !visibleDetail.document.wms_enabled}
          checked={includeValues} onChange={e => { setIncludeValues(e.target.checked); setDownloaded(''); }} />Dołącz historyczną wycenę</label>}
        <button className="button" type="button" disabled={reading} onClick={() => void download(visibleDetail.document)}>Pobierz cały dokument</button>
      </div>
      {downloaded && <p role="status">{downloaded}</p>}
    </section>}
  </section>;
}
