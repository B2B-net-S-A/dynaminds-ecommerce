import { z } from 'zod';

export const CATALOG_STOCK_CONTROL_LIMITS = { warehouses:100, rows:10000, page:100, history:50, previews:2000, operations:2000, tenant_bytes:134217728, export_bytes:8388608, preview_ttl_seconds:900 } as const;
export const catalogStockControlUuid=z.uuid().transform(v=>v.toLowerCase());
// abort: zod 4 runs the refine after a failed regex, and BigInt('1.0') throws instead of refusing.
export const catalogStockControlVersion=z.string().regex(/^(0|[1-9][0-9]{0,18})$/,{abort:true}).refine(v=>BigInt(v)<9223372036854775807n);
const versions=z.array(z.strictObject({warehouse_id:catalogStockControlUuid,version:catalogStockControlVersion})).max(100).refine(v=>new Set(v.map(x=>x.warehouse_id)).size===v.length);
export const catalogStockControlPreviewInput=z.strictObject({client_key:catalogStockControlUuid,catalog_version:catalogStockControlVersion,policy_version:catalogStockControlVersion,warehouse_policy_versions:versions,series_versions:versions});
export const catalogStockControlCommitInput=z.strictObject({client_key:catalogStockControlUuid,scope_hash:z.string().regex(/^[a-f0-9]{64}$/),confirmed:z.literal(true)});
export const catalogStockControlPageQuery=z.strictObject({cursor:z.coerce.number().int().min(0).max(10000).optional(),limit:z.coerce.number().int().min(1).max(100).default(100)});
export const catalogStockControlHistoryQuery=z.strictObject({catalog_id:catalogStockControlUuid.optional(),warehouse_id:catalogStockControlUuid.optional(),cursor:catalogStockControlUuid.optional(),limit:z.coerce.number().int().min(1).max(50).default(50)});
export const catalogStockControlExportQuery=z.strictObject({format:z.enum(['csv','xml']),include_values:z.enum(['true','false']).default('false').transform(v=>v==='true')});
export type CatalogStockControlActor={tenantId:string;userId:string|null;apiKeyId?:string;role?:'admin'|'operator'|'viewer';source?:'manual'|'api'|'system'};
export type CatalogStockControlPolicy={catalog_id:string;version:string;strict:boolean;operation_id:string|null};
export type CatalogStockControlWarehouse={id:string;name:string;code:string;policy:{usage:'sale'|'custody';enabled:boolean;version:string};series:{id:string|null;version:string;name:string;prefix:string}};
export type CatalogStockControlTotals={physical_quantity:string;reserved_quantity:string;known_quantity?:string;zero_cost_quantity?:string;unknown_quantity?:string;known_value_minor?:string;currency?:string;exponent?:number};
export type CatalogStockControlRow={ordinal:number;source_ordinal?:number;warehouse_id:string;product_id:string;sku:string;name:string;location:string;quantity:number;reserved:number;stock_version:string;bin_basis_hash:string;layer_id:string|null;lot_id:string|null;position_version:string|null;unit_cost_minor?:string|null;value_minor?:string|null;currency?:string;exponent?:number};
export type CatalogStockControlSnapshot={catalog:{id:string;name:string;version:string};policy:CatalogStockControlPolicy;warehouses:CatalogStockControlWarehouse[];wms_enabled:boolean;row_count:number;summary:CatalogStockControlTotals;rows_sha256?:string};
export type CatalogStockControlSource={snapshot:CatalogStockControlSnapshot;blockers:{code:string;message:string}[];ready:boolean;can_preview:boolean};
export type CatalogStockControlPreview={id:string;catalog_id:string;client_key:string;request:z.infer<typeof catalogStockControlPreviewInput>;scope_hash:string;snapshot:CatalogStockControlSnapshot;blockers:{code:string;message:string}[];ready:boolean;row_count:number;created_at:string;expires_at:string;operation_id:string|null;can_commit:boolean};
export type CatalogStockControlBoDocument={id:string;operation_id:string;catalog_id:string;warehouse:CatalogStockControlWarehouse;kind:'BO';number:string;series_id:string;series_version:string;year:number;sequence:string;row_count:number;summary:CatalogStockControlTotals;created_at:string};
export type CatalogStockControlOperation={id:string;catalog_id:string;preview_id:string;client_key:string;request:z.infer<typeof catalogStockControlCommitInput>;scope_hash:string;snapshot:CatalogStockControlSnapshot;before:CatalogStockControlPolicy;after:CatalogStockControlPolicy;documents:CatalogStockControlBoDocument[];created_at:string};
export type CatalogStockControlFlags={available:boolean;activation_available:boolean;writers_available:boolean;can_read:boolean;can_manage:boolean;can_read_value:boolean;current_role:string;read_only:boolean};
export type CatalogStockEffectSource={source_kind:'warehouse_document'|'purchase_receipt'|'dispatch'|'stocktake'|'location_operation'|'wms_movement'|'wms_receipt'|'return'|'wms_opening'|'catalog_import'|'inventory_import';source_id:string;warehouse_ids:string[];product_ids:string[]};
/** Trusted adapter token, never a public request or a SQL caller identity. */
export type CatalogStockEffectAdmission={id:string;tenant_id:string;source:CatalogStockEffectSource;strict_catalog_ids:string[];number:{kind:'PZ'|'MM'|'WZ'|'PW'|'RW';number:string;series_id:string;year:number;sequence:string}|null};
export type CatalogStockEffectProof={stock_movement_ids:string[];location_movement_ids:string[];layer_movement_ids:string[];warehouse_document_id?:string;operation_id?:string;location_operation_id?:string;receipt_id?:string};
