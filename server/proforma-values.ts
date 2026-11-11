import { createHash } from 'node:crypto';
import { z } from 'zod';

export const PROFORMA_LIMITS = {
  series: 100,
  lines: 100,
  page: 50,
  previews: 2000,
  preview_bytes: 1048576,
  history_bytes: 67108864,
  preview_minutes: 15,
  yearly_numbers: 999999,
} as const;
const uuid = z.uuid().transform((v) => v.toLowerCase());
const text = (min: number, max: number) =>
  z
    .string()
    .trim()
    .min(min)
    .max(max)
    .refine((v) => !/[\x00-\x1f\x7f-\x9f]/.test(v));
export const proformaSeller = z.strictObject({
  name: text(1, 200),
  street: text(1, 200),
  postal_code: text(1, 30),
  city: text(1, 100),
  country: z.string().regex(/^[A-Z]{2}$/),
  tax_id: text(1, 40).optional(),
});
export const proformaSeriesInput = z.strictObject({
  client_key: uuid,
  name: text(1, 120),
  prefix: z.string().regex(/^[A-Z0-9][A-Z0-9-]{0,11}$/),
  seller: proformaSeller,
  payment_terms_days: z.number().int().min(0).max(365),
  payment_instructions: text(0, 2000).default(''),
  notes: text(0, 2000).default(''),
});
export const proformaPreviewInput = z.strictObject({
  client_key: uuid,
  series_id: uuid,
  order_version: z
    .string()
    .regex(/^[1-9][0-9]{0,18}$/)
    .refine((v) => /^[1-9][0-9]{0,18}$/.test(v) && BigInt(v) <= 9223372036854775807n),
  shipping_vat: z.number().int().min(0).max(100),
});
export const proformaIssueInput = z.strictObject({
  client_key: uuid,
  scope_hash: z.string().regex(/^[a-f0-9]{64}$/),
  confirmed: z.literal(true),
  local_only: z.literal(true),
});
export const proformaPageQuery = z.strictObject({ cursor: uuid.optional() });
export type ProformaSeriesInput = z.infer<typeof proformaSeriesInput>;
export type ProformaPreviewInput = z.infer<typeof proformaPreviewInput>;
export type ProformaIssueInput = z.infer<typeof proformaIssueInput>;
export type ProformaActor = import('./domain').Actor & { apiKeyId?: string };
export type ProformaMoney = { gross_minor: string; net_minor: string; vat_minor: string };

/** Round each historical gross line to net once, half up, using integer arithmetic. */
export function proformaLineAmounts(
  grossMinor: bigint | string | number,
  vatRate: number,
): ProformaMoney {
  if (!Number.isInteger(vatRate) || vatRate < 0 || vatRate > 100)
    throw new Error('Niepoprawna stawka VAT proformy');
  if (typeof grossMinor === 'number' && (!Number.isSafeInteger(grossMinor) || grossMinor < 0))
    throw new Error('Niepoprawna kwota proformy');
  const raw = String(grossMinor);
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) throw new Error('Niepoprawna kwota proformy');
  const gross = BigInt(raw),
    denominator = 100n + BigInt(vatRate);
  const net = (2n * gross * 100n + denominator) / (2n * denominator);
  return {
    gross_minor: gross.toString(),
    net_minor: net.toString(),
    vat_minor: (gross - net).toString(),
  };
}
export function proformaTotals(
  lines: readonly ProformaMoney[],
  expectedGross: bigint | string,
): ProformaMoney {
  const totals = lines.reduce(
    (t, line) => {
      for (const value of [line.gross_minor, line.net_minor, line.vat_minor])
        if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error('Niepoprawna kwota pozycji proformy');
      if (BigInt(line.net_minor) + BigInt(line.vat_minor) !== BigInt(line.gross_minor))
        throw new Error('Kwoty pozycji proformy nie sumują się');
      return {
        gross: t.gross + BigInt(line.gross_minor),
        net: t.net + BigInt(line.net_minor),
        vat: t.vat + BigInt(line.vat_minor),
      };
    },
    { gross: 0n, net: 0n, vat: 0n },
  );
  if (!/^(0|[1-9][0-9]*)$/.test(String(expectedGross)) || totals.gross !== BigInt(expectedGross))
    throw new Error('Pozycje proformy nie sumują się do zamówienia');
  return {
    gross_minor: totals.gross.toString(),
    net_minor: totals.net.toString(),
    vat_minor: totals.vat.toString(),
  };
}
const canonical = (v: unknown): unknown =>
  v instanceof Date
    ? v.toISOString()
    : Array.isArray(v)
      ? v.map(canonical)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.entries(v)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([k, x]) => [k, canonical(x)]),
          )
        : v;
export function proformaRequestHash(
  tenantId: string,
  actorId: string,
  apiKeyId: string | null,
  kind: string,
  parentId: string | null,
  request: unknown,
) {
  return createHash('sha256')
    .update(
      JSON.stringify(
        canonical({
          tenant_id: tenantId,
          actor_id: actorId,
          api_key_id: apiKeyId,
          kind,
          parent_id: parentId,
          request,
        }),
      ),
    )
    .digest('hex');
}
