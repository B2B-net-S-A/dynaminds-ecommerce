import { z } from 'zod';
import { returnWmsLots } from './wms-lots-workflow-schema';
import type { B2bReturnLocalContext } from './b2b-return-local-origins-schema';

export const B2B_DROPSHIP_RETURN_LIMITS = Object.freeze({
  items: 100,
  physical_sources: 1000,
  page: 100,
  history: 2000,
  preview_bytes: 8 * 1024 * 1024,
  tenant_bytes: 128 * 1024 * 1024,
});
const version = z.number().int().min(1).max(2147483647);
const quantity = z.number().int().min(0).max(100000);
const money = z.number().int().min(0).max(1000000);
const note = z.string().trim().min(3).max(2000);
const address = z.strictObject({
  name: z.string().trim().min(1).max(200),
  street: z.string().trim().min(1).max(300),
  city: z.string().trim().min(1).max(100),
  postal_code: z.string().trim().min(1).max(20),
  country: z.string().regex(/^[A-Z]{2}$/),
  phone: z.string().trim().max(40).optional(),
});
export const b2bDropshipReturnSettingsInput = z.strictObject({
  client_key: z.uuid(),
  version: z.number().int().min(0).max(2147483647),
  enabled: z.boolean(),
  warehouse_id: z.uuid(),
  return_address: address,
  confirmed: z.literal(true),
});
export const b2bDropshipReturnPageQuery = z.strictObject({
  cursor: z.string().max(8192).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(100),
});
export const b2bDropshipReturnHistoryQuery = b2bDropshipReturnPageQuery.extend({
  side: z.enum(['buyer', 'supplier']).optional(),
  return_id: z.uuid().optional(),
});
export const b2bDropshipReturnPreviewInput = z
  .strictObject({
    client_key: z.uuid(),
    version,
    items: z
      .array(
        z.strictObject({
          customer_item_id: z.uuid(),
          dropship_order_id: z.uuid(),
          quantity: quantity.min(1),
          physical_sources: z
            .array(
              z.strictObject({
                supplier_item_id: z.uuid(),
                shipment_id: z.uuid(),
                quantity: quantity.min(1),
                issue_fragment_id: z.uuid().optional(),
              }),
            )
            .min(1)
            .max(1000),
        }),
      )
      .min(1)
      .max(100),
    supplier_shipping_refunds: z
      .array(
        z.strictObject({
          dropship_order_id: z.uuid(),
          amount_minor: money,
        }),
      )
      .max(100)
      .default([]),
    confirmed: z.literal(true),
  })
  .superRefine((v, ctx) => {
    if (v.items.reduce((n, i) => n + i.physical_sources.length, 0) > 1000)
      ctx.addIssue({ code: 'custom', message: 'Za dużo fragmentów fizycznego wydania' });
    const keys = v.items.map((i) => i.customer_item_id + ':' + i.dropship_order_id);
    if (new Set(keys).size !== keys.length)
      ctx.addIssue({ code: 'custom', message: 'Powtórzony zakres pozycji i dostawy' });
    if (
      new Set(v.supplier_shipping_refunds.map((i) => i.dropship_order_id)).size !==
      v.supplier_shipping_refunds.length
    )
      ctx.addIssue({ code: 'custom', message: 'Powtórzony zwrot dostawy dostawcy' });
  });
export const b2bDropshipReturnSubmitInput = z.strictObject({
  client_key: z.uuid(),
  version: z.literal(1),
  scope_hash: z.string().regex(/^[a-f0-9]{64}$/),
  confirmed: z.literal(true),
});
export const b2bDropshipReturnWithdrawInput = z.strictObject({
  client_key: z.uuid(),
  version,
  reason: note,
  confirmed: z.literal(true),
});
export const b2bDropshipReturnReceiveInput = z.strictObject({
  client_key: z.uuid(),
  version,
  supplier_return_version: version,
  shipping_refund_minor: money.default(0),
  note,
  items: z
    .array(
      z.strictObject({
        supplier_item_id: z.uuid(),
        accepted: quantity,
        restocked: quantity,
      }),
    )
    .min(1)
    .max(100),
  wms_lots: returnWmsLots.optional(),
  confirmed: z.literal(true),
});
export const b2bDropshipReturnDecisionInput = z.strictObject({
  client_key: z.uuid(),
  version,
  supplier_return_version: version,
  decision: z.literal('reject'),
  note,
  confirmed: z.literal(true),
});
export const b2bDropshipReturnReconcileInput = z.strictObject({
  client_key: z.uuid(),
  version,
  case_versions: z
    .array(z.strictObject({ id: z.uuid(), version }))
    .min(1)
    .max(100),
  items: z
    .array(
      z.strictObject({
        customer_item_id: z.uuid(),
        accepted: quantity,
      }),
    )
    .min(1)
    .max(100),
  shipping_refund_minor: money.default(0),
  note,
  confirmed: z.literal(true),
});

export type B2bDropshipReturnFlags = {
  available: boolean;
  read_only: boolean;
  current_role: string;
  can_read: boolean;
  can_manage: boolean;
  can_read_value: boolean;
};
export type B2bDropshipReturnPhysicalSource = {
  supplier_item_id: string;
  product_id: string;
  sku: string;
  name: string;
  shipment_id: string;
  issue_fragment_id?: string;
  quantity_available: number;
  quantity_per_unit: number;
};
export type B2bDropshipReturnSource = {
  customer_item_id: string;
  dropship_order_id: string;
  sku: string;
  name: string;
  requested: number;
  quantity_available: number;
  supplier_name: string;
  supplier_order_number: string;
  supplier_order_id: string;
  link_id: string;
  supplier_tenant_id: string;
  retail_currency: string;
  retail_line_total_minor?: string;
  wholesale_currency: string;
  physical_sources: B2bDropshipReturnPhysicalSource[];
  enabled: boolean;
  return_address: z.infer<typeof address> | null;
};
export type B2bDropshipReturnPreviewRow = {
  index: number;
  customer_item_id: string;
  dropship_order_id: string;
  sku: string;
  name: string;
  quantity: number;
  retail_currency: string;
  retail_refund_minor?: string;
  wholesale_currency: string;
  wholesale_refund_minor?: string;
  supplier_name: string;
  supplier_order_id: string;
  supplier_order_number: string;
  physical_sources: Array<B2bDropshipReturnPhysicalSource & { quantity: number }>;
};
export type B2bDropshipReturnPreview = {
  id: string;
  version: 1;
  return_id: string;
  order_id: string;
  scope_hash: string;
  total: number;
  group_count: number;
  created_at: string;
  expires_at: string;
  executed_case_ids: string[];
  can_submit: boolean;
  groups: Array<{
    dropship_order_id: string;
    supplier_name: string;
    supplier_order_id: string;
    supplier_order_number: string;
    return_address: z.infer<typeof address>;
    supplier_shipping_refund_minor?: string;
    wholesale_currency: string;
  }>;
};
export type B2bDropshipReturnCase = {
  id: string;
  preview_id: string;
  dropship_order_id: string;
  link_id: string;
  buyer_return_id: string;
  buyer_order_id: string;
  supplier_return_id: string;
  supplier_order_id: string;
  supplier_order_number: string;
  supplier_name: string;
  warehouse_id: string;
  wms_lots_enabled: boolean;
  number: string;
  state: 'requested' | 'received' | 'rejected' | 'withdrawn';
  version: number;
  supplier_return_version: number;
  side: 'buyer' | 'supplier';
  created_at: string;
  received_at: string | null;
  retail_reconciled_at: string | null;
  retail_currency: string;
  wholesale_currency: string;
  wholesale_refund_minor?: string;
  retail_refund_minor?: string;
  return_address: z.infer<typeof address>;
  supplier_items: Array<{
    supplier_item_id: string;
    sku: string;
    name: string;
    requested: number;
    accepted: number;
    restocked: number;
    refund_minor?: string;
  }>;
  can_withdraw: boolean;
  can_receive: boolean;
  can_reject: boolean;
  can_reconcile: boolean;
};
export type B2bDropshipReturnContext = B2bReturnLocalContext & {
  side: 'buyer' | 'supplier' | null;
  return_id: string;
  version: number;
  currency: string;
  shipping_refund_available_minor?: string;
  retail_items: Array<{
    customer_item_id: string;
    sku: string;
    name: string;
    requested: number;
    accepted_available: number;
    refund_minor?: string;
  }>;
  case_refs: Array<{ id: string; number: string; state: string; version: number }>;
  can_receive_locally: boolean;
  can_preview: boolean;
  can_reconcile: boolean;
  limits: typeof B2B_DROPSHIP_RETURN_LIMITS;
};
export type B2bDropshipReturnEvent = {
  id: string;
  kind: 'submit' | 'receive' | 'reject' | 'withdraw' | 'reconcile';
  created_at: string;
  actor_name: string;
  note: string;
  result: { accepted?: number; restocked_at_supplier?: number; case_ids?: string[] };
};
