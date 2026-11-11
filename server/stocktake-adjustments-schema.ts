import { z } from 'zod';

export const STOCKTAKE_ADJUSTMENT_LIMITS = Object.freeze({
  series: 100, previews: 5000, receipts: 5000, source_lines: 10000,
  fragments: 10000, row_page: 100, header_page: 50, preview_ttl_seconds: 900,
  request_bytes: 65536, response_bytes: 5 * 1024 * 1024,
  tenant_evidence_bytes: 128 * 1024 * 1024,
});
export const adjustmentUuid = z.uuid().transform(v => v.toLowerCase());
export const adjustmentVersion = z.string().regex(/^[1-9][0-9]{0,18}$/)
  .refine(v => BigInt(v) <= 9223372036854775807n);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const text = (min: number, max: number) => z.string().trim().min(min).max(max)
  .refine(v => !/[\u0000-\u001f\u007f\p{Cs}]/u.test(v));
export const adjustmentSeriesInput = z.strictObject({ client_key: adjustmentUuid,
  kind: z.enum(['PW', 'RW']), name: text(2, 120),
  prefix: z.string().regex(/^[A-Z][A-Z0-9_-]{0,19}$/),
});
const common = { client_key: adjustmentUuid, stocktake_id: adjustmentUuid,
  version: adjustmentVersion, pw_series_id: adjustmentUuid.optional(), rw_series_id: adjustmentUuid.optional() };
export const adjustmentPreviewInput = z.discriminatedUnion('source_kind', [
  z.strictObject({ ...common, source_kind: z.literal('quantity'), review_hash: hash }),
  z.strictObject({ ...common, source_kind: z.literal('wms'), review_id: adjustmentUuid, scope_hash: hash }),
]);
export const adjustmentPostInput = z.strictObject({ client_key: adjustmentUuid,
  scope_hash: hash, confirmed: z.literal(true) });
export const adjustmentRowsQuery = z.strictObject({ cursor: z.string().regex(/^(0|[1-9][0-9]{0,4})$/).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(100) });
export const adjustmentHistoryQuery = z.strictObject({ cursor: adjustmentUuid.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(50),
  kind: z.enum(['PW','RW']).optional(), warehouse_id: adjustmentUuid.optional(),
  source_kind: z.enum(['quantity','wms']).optional(), stocktake_id: adjustmentUuid.optional() });
const registerDate = z.iso.datetime().max(27).regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/)
  .refine(v=>v.slice(0,4)!=='0000')
  .transform(v=>v.slice(0,19)+'.'+(v.match(/\.(\d+)Z$/)?.[1]??'').padEnd(6,'0')+'Z');
export const adjustmentRegisterQuery = z.strictObject({
  cursor: z.string().min(1).max(4096).regex(/^[A-Za-z0-9_-]+$/).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(50),
  kind: z.enum(['PW','RW']).optional(), source_kind: z.enum(['quantity','wms']).optional(),
  warehouse_id: adjustmentUuid.optional(), number_prefix: text(1,100).optional(),
  from: registerDate.optional(), to: registerDate.optional(),
}).refine(q => !q.from || !q.to || q.from<=q.to, {message:'Zakres dat jest odwrócony'});
export const adjustmentExportQuery = z.strictObject({ format: z.enum(['csv','xml']),
  include_values: z.enum(['true','false']).default('false').transform(v=>v==='true') });
export const adjustmentSourceParams = z.strictObject({ source_kind: z.enum(['quantity','wms']), id: adjustmentUuid });
export type AdjustmentActor = { tenantId: string; userId: string; role: 'admin'|'operator'|'viewer';
  apiKeyId?: string; source?: 'manual'|'api' };
export type AdjustmentSeries = { id: string; kind: 'PW'|'RW'; name: string; prefix: string;
  version: '1'; created_at: string };
export type AdjustmentFlags = { available: boolean; read_only: boolean; current_role: string|null;
  can_read: boolean; can_write: boolean; can_read_value: boolean };
export type AdjustmentTotals = { pw_quantity: string; rw_quantity: string; currency?: string; exponent?: number;
  known_pw_minor?: string; known_rw_minor?: string; unknown_pw_quantity?: string; unknown_rw_quantity?: string };
export type AdjustmentSource = { source_kind: 'quantity'|'wms'; stocktake_id: string; version: string;
  state: string; name: string; warehouse: { id: string; name: string; code: string; policy: { usage: 'sale'|'custody'; enabled: boolean; version: string } };
  review_hash: string|null; review_id: string|null; scope_hash: string|null;
  line_count: number; row_count: number; summary: AdjustmentTotals; can_preview: boolean };
export type AdjustmentRow = { ordinal: number; line_id: string; product_id: string; sku: string; name: string;
  warehouse_id: string; location: string; kind: 'PW'|'RW'; quantity: number; delta: number;
  lot_id: string|null; lot_code: string|null; expiry_date: string|null; layer_id: string|null;
  unit_cost_minor?: string|null; currency?: string|null; value_minor?: string|null };
export type AdjustmentDocumentRow = AdjustmentRow & { source_ordinal: number;
  movement_id: string; stock_movement_id: string|null };
export type AdjustmentSnapshot = { source: AdjustmentSource; year: number;
  series: { PW: AdjustmentSeries|null; RW: AdjustmentSeries|null };
  row_count: number; rows_sha256?: string; summary: AdjustmentTotals };
export type AdjustmentPreview = { id: string; source_kind: 'quantity'|'wms'; stocktake_id: string;
  request: z.infer<typeof adjustmentPreviewInput>; scope_hash: string; snapshot: AdjustmentSnapshot;
  created_at: string; expires_at: string; can_post: boolean; receipt_id: string|null };
export type AdjustmentDocument = { id: string; receipt_id: string; kind: 'PW'|'RW'; number: string;
  series_id: string; year: number; sequence: string; source_kind: 'quantity'|'wms'; stocktake_id: string;
  warehouse: AdjustmentSource['warehouse']; row_count: number; summary: AdjustmentTotals; created_at: string };
export type AdjustmentReceipt = { id: string; preview_id: string; client_key: string; scope_hash: string;
  request: z.infer<typeof adjustmentPostInput>; snapshot: AdjustmentSnapshot;
  source: { source_kind: 'quantity'|'wms'; stocktake_id: string; posting_id: string|null; operation_id: string|null; version: string; state: 'posted' };
  documents: AdjustmentDocument[]; created_at: string };
export type AdjustmentRegister = { data: AdjustmentDocument[]; meta: { cursor: string|null; limit: number } } & AdjustmentFlags;
export type AdjustmentExport = { document: AdjustmentDocument; filename: string;
  content_type: 'text/csv; charset=utf-8'|'application/xml; charset=utf-8'; content: string;
  format: 'csv'|'xml'; values_included: boolean; row_count: number } & AdjustmentFlags;
