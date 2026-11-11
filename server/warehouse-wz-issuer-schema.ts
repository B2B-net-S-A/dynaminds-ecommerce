import { z } from 'zod';

export const WZ_ISSUER_LIMITS = { documents: 5000, rows: 10000, tenant_bytes: 134217728 } as const;
const uuid = z.uuid().transform(s => s.toLowerCase());
const common = { order_id: uuid, shipment_id: uuid };
/** Server-created identities only. Never parse this from a dispatch HTTP body. */
export const automaticWzSourceInput = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('demo'), ...common }),
  z.strictObject({ kind: z.literal('shipping_plan'), ...common, plan_id: uuid }),
  z.strictObject({ kind: z.literal('parcel'), ...common, plan_id: uuid,
    parcel_index: z.number().int().min(0).max(49), dispatch_id: uuid }),
]);
export type AutomaticWzSource = z.infer<typeof automaticWzSourceInput>;
export type AutomaticWzPhysical = {
  stock_movements: Array<{ id:string;product_id:string;warehouse_id:string;quantity:number }>;
  location_movements: Array<{ id:string;product_id:string;warehouse_id:string;location:string;quantity:number }>;
  wms: null | Array<{ operation_id:string;fragment_ids:string[];layer_movement_ids:string[] }>
    | { operation_id:string;fragment_ids:string[];physical_quantity:number };
};
export type AutomaticWzDocument = {
  id:string;kind:'WZ';receipt_id:string;number:string;series_id:string;year:number;sequence:string;
  warehouse:{id:string;name:string;code:string};source:AutomaticWzSource;created_at:string;row_count:number;
  summary:{physical_quantity:number;known_value_minor?:string;unknown_quantity?:number;currency?:string;exponent?:number};
  commercial_lines:Array<Record<string,unknown>>;
};
