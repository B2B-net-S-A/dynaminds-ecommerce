import { z } from 'zod';

export const PAYMENT_IMPORT_ALLOCATION_LIMITS = {
  allocations: 100,
  page: 50,
  previews: 2000,
  history_bytes: 134217728,
  preview_bytes: 8388608,
} as const;
const uuid = z.uuid().transform((v) => v.toLowerCase());
const minor = z.number().int().min(0).max(2147483647);
export const allocationItem = z
  .strictObject({
    order_id: uuid,
    shipment_id: uuid.optional(),
    amount_minor: minor,
    fee_minor: minor,
  })
  .refine((v) => v.amount_minor + v.fee_minor > 0, 'Przydział musi zawierać kwotę lub opłatę');
export const allocationPreviewInput = z
  .strictObject({
    client_key: uuid,
    source_preview_id: uuid,
    source_row_id: uuid,
    source_version: z.number().int().min(0).max(2147483646),
    allocations: z.array(allocationItem).min(1).max(100),
    unallocated_minor: minor,
    unallocated_fee_minor: minor,
    reason: z
      .string()
      .trim()
      .min(3)
      .max(2000)
      .refine((v) => !/[\x00-\x1f\x7f]/.test(v)),
  })
  .refine(
    (v) =>
      new Set(v.allocations.map((r) => JSON.stringify([r.order_id, r.shipment_id ?? null])))
        .size === v.allocations.length,
    'Powtórzony cel przydziału',
  );
export const allocationExecuteInput = z.strictObject({
  client_key: uuid,
  version: z.literal(1),
  scope_hash: z.string().regex(/^[a-f0-9]{64}$/),
  confirmed: z.literal(true),
  local_ledger_only: z.literal(true),
});
export const allocationOptionsQuery = z
  .strictObject({ source_preview_id: uuid.optional(), source_row_id: uuid.optional() })
  .refine(
    (v) => Boolean(v.source_preview_id) === Boolean(v.source_row_id),
    'Wymagany podgląd i wiersz źródłowy',
  );
export const allocationPageQuery = z.strictObject({
  kind: z.enum(['preview', 'execution']).default('execution'),
  cursor: uuid.optional(),
});
export type PaymentImportAllocationActor = import('./domain').Actor & { apiKeyId?: string };
export type PaymentImportAllocationInput = z.infer<typeof allocationPreviewInput>;
/** BigInt is used even though each individual ledger entry is an int32. */
export function paymentImportAllocationTotals(input: PaymentImportAllocationInput) {
  return {
    amount_minor: input.allocations.reduce((n, r) => n + BigInt(r.amount_minor), 0n),
    fee_minor: input.allocations.reduce((n, r) => n + BigInt(r.fee_minor), 0n),
    unallocated_minor: BigInt(input.unallocated_minor),
    unallocated_fee_minor: BigInt(input.unallocated_fee_minor),
  };
}
export type PaymentImportAllocationSource = {
  source_preview_id: string;
  source_row_id: string;
  source_version: number;
  transaction_id: string;
  ledger_kind: string;
  currency: string;
  gross_minor: string;
  fee_minor: string;
  available_minor: string;
  remaining_minor: string;
  remaining_amount_minor: string;
  remaining_fee_minor: string;
  can_allocate: boolean;
};
export type PaymentImportAllocationBalance = {
  amount_due: string;
  received: string;
  refunded: string;
  credit: string;
  currency: string;
  // Absent in immutable receipts created before migration126.
  overpayment?: string;
  collected?: string;
  remitted?: string;
  fees?: string;
  courier_due?: string;
};
export type PaymentImportAllocationShipmentSums = {
  collected: string;
  settled: string;
  // Absent in immutable receipts created before migration126.
  remitted?: string;
  fees?: string;
  courier_due?: string;
};
export type PaymentImportAllocationRow = {
  index: number;
  order_id: string;
  shipment_id: string | null;
  amount_minor: number;
  fee_minor: number;
  before: {
    order: any;
    owner: any;
    balance: PaymentImportAllocationBalance;
    shipment: any;
    shipment_sums: PaymentImportAllocationShipmentSums;
  };
  after: {
    balance: PaymentImportAllocationBalance;
    shipment_sums: PaymentImportAllocationShipmentSums;
  };
  entry_id?: string;
  before_balance?: PaymentImportAllocationBalance;
  after_balance?: PaymentImportAllocationBalance;
  after_shipment_sums?: PaymentImportAllocationShipmentSums;
};
export type PaymentImportAllocationHead = {
  id: string;
  version: 1;
  scope_hash: string;
  source_preview_id: string;
  source_row_id: string;
  source_version: number;
  summary: {
    count: number;
    amount_minor: number;
    fee_minor: number;
    unallocated_minor: number;
    unallocated_fee_minor: number;
    currency: string;
  };
  created_at: string;
  expires_at?: string;
  can_execute?: boolean;
  executed_execution_id?: string | null;
};
