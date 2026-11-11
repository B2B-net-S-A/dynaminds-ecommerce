import type { WarehouseWmsCorrectionRow,WarehouseWmsCorrectionSummary } from './warehouse-wms-correction-projection';
import { z } from 'zod';
import { adjustmentUuid, adjustmentExportQuery, type AdjustmentActor, type AdjustmentFlags, type AdjustmentTotals, type AdjustmentDocumentRow } from './stocktake-adjustments-schema';

export const WAREHOUSE_DOCUMENT_REGISTER_LIMITS = Object.freeze({ page:50, rows:10000, response_bytes:5*1024*1024 });
export const warehouseRegisterOrigin = z.enum(['warehouse','stocktake_adjustment','wms_correction']);
export const warehouseRegisterKind = z.enum(['PZ','MM','WZ','count','PW','RW']);
const date = z.iso.datetime().max(27).regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/)
  .refine(v=>v.slice(0,4)!=='0000').transform(v=>v.slice(0,19)+'.'+(v.match(/\.(\d+)Z$/)?.[1]??'').padEnd(6,'0')+'Z');
export const warehouseRegisterQuery = z.strictObject({
  origin:warehouseRegisterOrigin.optional(),kind:warehouseRegisterKind.optional(),
  status:z.enum(['draft','posted','cancelled']).optional(),source_kind:z.enum(['warehouse','quantity','wms']).optional(),
  warehouse_id:adjustmentUuid.optional(),number_prefix:z.string().trim().min(1).max(100).refine(v=>!/[\u0000-\u001f\u007f\p{Cs}]/u.test(v)).optional(),
  from:date.optional(),to:date.optional(),limit:z.coerce.number().int().min(1).max(50).default(50),
  cursor:z.string().min(1).max(4096).regex(/^[A-Za-z0-9_-]+$/).optional(),
}).refine(q=>!q.from||!q.to||q.from<=q.to,{message:'Zakres dat jest odwrócony'});
export const warehouseRegisterParams=z.strictObject({origin:warehouseRegisterOrigin,id:adjustmentUuid});
export const warehouseRegisterExportQuery=adjustmentExportQuery;
export type WarehouseRegisterActor=AdjustmentActor;
export type WarehouseRegisterFlags=AdjustmentFlags;
export type WarehouseRegisterWarehouse={id:string;name:string;code:string};
export type WarehouseRegisterHeader={origin:z.infer<typeof warehouseRegisterOrigin>;id:string;
  kind:z.infer<typeof warehouseRegisterKind>;number:string;status:'draft'|'posted'|'cancelled';created_at:string;
  source_kind:'warehouse'|'quantity'|'wms';warehouse:WarehouseRegisterWarehouse;
  destination:WarehouseRegisterWarehouse|null;warehouse_names:'current'|'frozen';row_count:number;
  value_available:boolean;summary:AdjustmentTotals|WarehouseWmsCorrectionSummary|null};
export type WarehouseRegisterLegacyRow={origin:'warehouse';ordinal:number;product_id:string;sku:string;name:string;
  quantity:number;location:string;expected_on_hand:number;expected_reserved:number;expected_version:string|null};
export type WarehouseRegisterAdjustmentRow=AdjustmentDocumentRow & {origin:'stocktake_adjustment'};
export type WarehouseRegisterRow=WarehouseRegisterLegacyRow|WarehouseRegisterAdjustmentRow|WarehouseWmsCorrectionRow;
export type WarehouseRegisterMovement={id:string;product_id:string;warehouse_id:string;delta:number;kind:string;created_at:string};
export type WarehouseRegisterEvidence={origin:'warehouse';version:string;reference:string;note:string;posted_at:string|null}
  |{origin:'stocktake_adjustment';receipt_id:string;preview_id:string;stocktake_id:string;posting_id:string|null;operation_id:string|null;series_id:string;year:number;sequence:string}
  |{origin:'wms_correction';protocol:'wms_adjustment';preview_id:string;operation_id:string;warehouse_document_id:string;warehouse_document_number:string;warehouse_document_kind:'PZ'|'WZ';series_id:string;year:number;sequence:string};
export type WarehouseRegisterDetail={document:WarehouseRegisterHeader;rows:WarehouseRegisterRow[];
  movements:WarehouseRegisterMovement[];evidence:WarehouseRegisterEvidence;row_names:'recorded';snapshot_at:string};
export type WarehouseRegisterPage={data:WarehouseRegisterHeader[];meta:{cursor:string|null;limit:number};snapshot_at:string}&WarehouseRegisterFlags;
export type WarehouseRegisterDetailReply=WarehouseRegisterDetail&WarehouseRegisterFlags;
export type WarehouseRegisterExport={document:WarehouseRegisterHeader;filename:string;content_type:'text/csv; charset=utf-8'|'application/xml; charset=utf-8';
  content:string;format:'csv'|'xml';values_included:boolean;row_count:number;snapshot_at:string}&WarehouseRegisterFlags;
