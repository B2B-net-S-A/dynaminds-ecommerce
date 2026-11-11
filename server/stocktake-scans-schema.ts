import { z } from 'zod';
import type { Actor } from './domain';
export type StocktakeScanActor = Actor;
export type StocktakeScanEngine = 'wms' | 'quantity';
export const STOCKTAKE_SCAN_LIMITS = {
  code_utf16: 80,
  page: 100,
  increment: 1,
  token_ttl_seconds: 900,
  receipts_per_stocktake: 100000,
  receipts_per_tenant: 1000000,
  request_bytes: 16384,
  response_bytes: 5242880,
  evidence_bytes: 134217728,
} as const;
const uuid = z.uuid().transform((v) => v.toLowerCase());
const text = (n: number) =>
  z
    .string()
    .trim()
    .min(1)
    .refine(
      (v) =>
        v.length <= n && !/[\u0000-\u001f\u007f]/.test(v) && Buffer.from(v).toString('utf8') === v,
      'Nieprawidłowy tekst lub limit UTF-16',
    );
export const stocktakeScanCode = text(80);
const version = z
  .string()
  .regex(/^[1-9][0-9]*$/)
  .max(19)
  .refine((v) => BigInt(v) <= 9223372036854775807n, 'Wersja poza int64');
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const page = {
  cursor: z.string().max(2048).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
};
export const stocktakeScanCandidatesQuery = z.strictObject({
  ...page,
  code: stocktakeScanCode,
  location: text(80),
});
export const stocktakeScanHistoryQuery = z.strictObject({ ...page, line_id: uuid.optional() });
const common = {
  client_key: uuid,
  line_id: uuid,
  version,
  basis_token: hash,
  code: stocktakeScanCode,
  location: text(80),
  resolution_token: hash,
  expires_at: z.iso.datetime(),
};
export const stocktakeScanStartInput = z.strictObject({
  ...common,
  confirmed_zero: z.literal(true),
  confirmed_reset: z.boolean(),
  note: text(500).refine((v) => v.length >= 3, 'Notatka wymaga co najmniej 3 znaków'),
});
export const stocktakeScanIncrementInput = z.strictObject({
  ...common,
  generation_id: uuid,
  increment: z.literal(1),
});
export type StocktakeScanStartInput = z.infer<typeof stocktakeScanStartInput>;
export type StocktakeScanIncrementInput = z.infer<typeof stocktakeScanIncrementInput>;
