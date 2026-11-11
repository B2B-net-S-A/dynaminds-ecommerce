import { z } from 'zod';
import type { Actor } from './domain';
import { wmsStocktakeLot } from './wms-stocktakes-schema';

export const STOCK_FILE_IMPORT_LIMITS = {
  file_bytes: 2097152,
  request_bytes: 6291456,
  source_rows: 500,
  products: 500,
  warehouses: 8,
  positions: 4000,
  expanded_layers: 10000,
  quantity: 1000000,
  page: 50,
  preview_bytes: 33554432,
  history_per_tenant: 2000,
  history_bytes: 268435456,
  profiles: 100,
} as const;
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
const uuid = z.uuid().transform((v) => v.toLowerCase());
const text = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine(
      (v) => !v.includes('\0') && Buffer.from(v, 'utf8').toString('utf8') === v,
      'Tekst musi być poprawnym Unicode bez NUL',
    );
const field = text(80).refine((v) => !forbidden.has(v), 'Niedozwolona nazwa pola');
const location = text(80).refine(
  (v) => !/[\u0000-\u001f\u007f]/.test(v),
  'Niepoprawna lokalizacja',
);
const currency = z.enum(['PLN', 'EUR', 'USD', 'GBP', 'CZK']);
const quantity = z.number().int().min(0).max(STOCK_FILE_IMPORT_LIMITS.quantity);
// Zod runs refinements after a failed regex too; do not call BigInt on malformed input.
const minorPattern = /^(0|[1-9][0-9]{0,18})$/;
const minor = z
  .string()
  .regex(minorPattern)
  .refine(
    (v) => minorPattern.test(v) && BigInt(v) <= 9223372036854775807n,
    'Koszt przekracza int64 lub ma niepoprawny zapis',
  );
const version = z.number().int().positive().max(2147483647);
export const stockFileImportDefinition = z.strictObject({
  format: z.enum(['csv', 'xml']),
  xml_mode: z.enum(['positions', 'catalog']),
  delimiter: z.enum([';', ',', '\t']),
  identity: z.enum(['uuid', 'sku', 'historical_sku', 'ean', 'name']),
  identity_field: field,
  spreadsheet_safe: z.boolean(),
  empty_policy: z.enum(['skip', 'error']),
});
export const stockFileImportTarget = z.strictObject({
  warehouse_id: uuid,
  quantity_scope: z.enum(['position', 'warehouse_total']),
  mapping: z
    .strictObject({
      quantity: field,
      location: field.optional(),
      operation: field.optional(),
      lot_id: field.optional(),
      lot_code: field.optional(),
      expiry_date: field.optional(),
      unit_cost_minor: field.optional(),
      currency: field.optional(),
    })
    .refine(
      (v) => new Set(Object.values(v)).size === Object.values(v).length,
      'Powtórzone pole mapowania',
    ),
  default_location: location.nullable(),
});
export const stockFileImportPosition = z
  .strictObject({
    location,
    lot: wmsStocktakeLot.nullable(),
    quantity,
    unit_cost_minor: minor.nullable(),
    currency: currency.nullable(),
  })
  .refine(
    (v) => (v.unit_cost_minor === null) === (v.currency === null),
    'Koszt i waluta muszą występować razem',
  );
const targets = z
  .array(stockFileImportTarget)
  .min(1)
  .max(8)
  .refine((v) => new Set(v.map((t) => t.warehouse_id)).size === v.length, 'Powtórzony magazyn')
  .transform((v) => v.sort((a, b) => a.warehouse_id.localeCompare(b.warehouse_id)));
const configuration = z
  .strictObject({ definition: stockFileImportDefinition, targets })
  .superRefine((v, c) => {
    for (const [i, t] of v.targets.entries()) {
      if (Object.values(t.mapping).includes(v.definition.identity_field))
        c.addIssue({
          code: 'custom',
          path: ['targets', i, 'mapping'],
          message: 'Tożsamość nie jest pomiarem',
        });
      if (
        v.definition.format === 'xml' &&
        v.definition.xml_mode === 'catalog' &&
        (t.quantity_scope !== 'warehouse_total' || t.mapping.quantity !== 'inventory_json')
      )
        c.addIssue({
          code: 'custom',
          path: ['targets', i],
          message: 'XML katalogu wymaga agregatu inventory_json',
        });
    }
  });
const resolution = z
  .strictObject({
    source_index: z.number().int().min(0).max(499),
    warehouse_id: uuid,
    positions: z.array(stockFileImportPosition).min(1).max(4000),
  })
  .refine(
    (v) =>
      new Set(
        v.positions.map((p) =>
          JSON.stringify([p.location, p.lot?.kind === 'existing' ? p.lot.lot_id : p.lot]),
        ),
      ).size === v.positions.length,
    'Powtórzona pozycja fizyczna',
  );
export const stockFileImportPreviewInput = z
  .strictObject({
    client_key: uuid,
    file_name: text(120),
    content: text(STOCK_FILE_IMPORT_LIMITS.file_bytes),
    note: text(500).refine((v) => v.trim().length >= 3, 'Podaj uzasadnienie pomiaru'),
    definition: stockFileImportDefinition,
    targets,
    resolutions: z.array(resolution).max(4000).default([]),
  })
  .superRefine((v, c) => {
    // Only configuration fields belong to its strict object.
    const actual = configuration.safeParse({ definition: v.definition, targets: v.targets });
    if (!actual.success)
      for (const issue of actual.error.issues) c.addIssue({ ...issue, code: 'custom' });
    const seen = new Set<string>();
    let positions = 0;
    for (const r of v.resolutions) {
      const key = r.source_index + ':' + r.warehouse_id;
      if (seen.has(key)) c.addIssue({ code: 'custom', message: 'Powtórzone rozwiązanie pomiaru' });
      seen.add(key);
      if (!v.targets.some((t) => t.warehouse_id === r.warehouse_id))
        c.addIssue({ code: 'custom', message: 'Rozwiązanie poza wybranymi magazynami' });
      positions += r.positions.length;
    }
    if (positions > STOCK_FILE_IMPORT_LIMITS.positions)
      c.addIssue({ code: 'custom', message: 'Za dużo rozwiązanych pozycji fizycznych' });
  });
const acknowledgements = z
  .array(uuid)
  .max(8)
  .default([])
  .refine((v) => new Set(v).size === v.length, 'Powtórzona zgoda')
  .transform((v) => v.sort());
export const stockFileImportExecuteInput = z.strictObject({
  client_key: uuid,
  scope_hash: z.string().regex(/^[a-f0-9]{64}$/),
  confirmed: z.literal(true),
  ack_unknown_loss_warehouse_ids: acknowledgements,
  ack_surplus_warehouse_ids: acknowledgements,
});
export const stockFileImportProfileInput = z
  .strictObject({
    client_key: uuid,
    name: text(120),
    definition: stockFileImportDefinition,
    targets,
  })
  .superRefine((v, c) => {
    const result = configuration.safeParse({ definition: v.definition, targets: v.targets });
    if (!result.success)
      for (const issue of result.error.issues) c.addIssue({ ...issue, code: 'custom' });
  });
export const stockFileImportProfileUpdateInput = stockFileImportProfileInput.safeExtend({
  version,
});
export const stockFileImportOptionsQuery = z.strictObject({
  cursor: uuid.optional(),
  search: z.string().max(100).default(''),
});
export const stockFileImportPageQuery = z.strictObject({ cursor: uuid.optional() });
export const stockFileImportRowsQuery = z.strictObject({
  cursor: z
    .string()
    .regex(/^(0|[1-9][0-9]{0,3})$/)
    .optional(),
});
export type StockFileImportDefinition = z.infer<typeof stockFileImportDefinition>;
export type StockFileImportTarget = z.infer<typeof stockFileImportTarget>;
export type StockFileImportPosition = z.infer<typeof stockFileImportPosition>;
export type StockFileImportInput = z.infer<typeof stockFileImportPreviewInput>;
export type StockFileImportActor = Actor & {
  apiKeyId?: string;
  source?: 'manual' | 'api';
  canReadValue?: boolean;
};
export type ParsedStockFile = {
  source_hash: string;
  rows: Array<{
    source_index: number;
    raw_cells: Record<string, unknown>;
    identity: string | null;
    errors: string[];
    cells: Array<{
      warehouse_id: string;
      operation: 'none' | 'count';
      quantity: number | null;
      positions: StockFileImportPosition[];
      errors: string[];
    }>;
  }>;
};
