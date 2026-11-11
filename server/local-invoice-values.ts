export function validLocalInvoiceNip(v: string): boolean { return /^[0-9]{10}$/.test(v) && v !== '0000000000' && [6,5,7,2,3,4,5,6,7].reduce((n,w,i)=>n+w*Number(v[i]),0)%11 === Number(v[9]); }
import { createHash } from 'node:crypto';
import { z } from 'zod';

export const LOCAL_INVOICE_LIMITS = {
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
export const localInvoiceSeller = z.strictObject({
  name: text(1, 200),
  street: text(1, 200),
  postal_code: text(1, 30),
  city: text(1, 100),
  country: z.literal('PL'),
  tax_id: z.string().regex(/^[0-9]{10}$/).refine(validLocalInvoiceNip),
});
export const localInvoiceSeriesInput = z.strictObject({
  client_key: uuid,
  name: text(1, 120),
  prefix: z.string().regex(/^[A-Z0-9][A-Z0-9-]{0,11}$/),
  seller: localInvoiceSeller,
  payment_terms_days: z.number().int().min(0).max(365),
  payment_instructions: text(0, 2000).default(''),
  notes: text(0, 2000).default(''),
  seller_vat_status: z.literal('active_domestic'),
});
export const localInvoiceBuyer = z.strictObject({kind:z.literal('consumer'),name:text(1,200),street:text(1,200),postal_code:text(1,30),city:text(1,100),country:z.literal('PL')});
export const localInvoicePreviewInput = z.strictObject({
  client_key: uuid,
  series_id: uuid,
  order_version: z
    .string()
    .regex(/^[1-9][0-9]{0,18}$/)
    .refine((v) => /^[1-9][0-9]{0,18}$/.test(v) && BigInt(v) <= 9223372036854775807n),
  shipping_vat: z.union([z.literal(0),z.literal(5),z.literal(8),z.literal(23)]),
  buyer: localInvoiceBuyer,
  sell_date: z.iso.date(),
  tax_regime: z.literal('ordinary_domestic'),
  consumer_sale_confirmed: z.literal(true),
  no_special_tax_procedure_confirmed: z.literal(true),
  not_fiscal_receipt_confirmed: z.literal(true),
});
export const localInvoiceIssueInput = z.strictObject({
  client_key: uuid,
  scope_hash: z.string().regex(/^[a-f0-9]{64}$/),
  confirmed: z.literal(true),
  local_only: z.literal(true),
});
export const localInvoicePageQuery = z.strictObject({ cursor: uuid.optional() });
export type LocalInvoiceSeriesInput = z.infer<typeof localInvoiceSeriesInput>;
export type LocalInvoicePreviewInput = z.infer<typeof localInvoicePreviewInput>;
export type LocalInvoiceIssueInput = z.infer<typeof localInvoiceIssueInput>;
export type LocalInvoiceActor = Readonly<import('./domain').Actor & { apiKeyId?: string }>;
export type LocalInvoiceMoney = { gross_minor: string; net_minor: string; vat_minor: string };

/** Art106e7–11 gross-price method: round VAT per frozen gross line, then subtract. */
export function localInvoiceLineAmounts(
  grossMinor: bigint | string | number,
  vatRate: number,
): LocalInvoiceMoney {
  if (!Number.isInteger(vatRate) || ![0,5,8,23].includes(vatRate))
    throw new Error('Niepoprawna stawka VAT faktury');
  if (typeof grossMinor === 'number' && (!Number.isSafeInteger(grossMinor) || grossMinor < 0))
    throw new Error('Niepoprawna kwota faktury');
  const raw = String(grossMinor);
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) throw new Error('Niepoprawna kwota faktury');
  const gross = BigInt(raw),
    denominator = 100n + BigInt(vatRate);
  const vat = (2n * gross * BigInt(vatRate) + denominator) / (2n * denominator);
  const net = gross - vat;
  return {
    gross_minor: gross.toString(),
    net_minor: net.toString(),
    vat_minor: (gross - net).toString(),
  };
}
export function localInvoiceTotals(
  lines: readonly LocalInvoiceMoney[],
  expectedGross: bigint | string,
): LocalInvoiceMoney {
  const totals = lines.reduce(
    (t, line) => {
      for (const value of [line.gross_minor, line.net_minor, line.vat_minor])
        if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error('Niepoprawna kwota pozycji faktury');
      if (BigInt(line.net_minor) + BigInt(line.vat_minor) !== BigInt(line.gross_minor))
        throw new Error('Kwoty pozycji faktury nie sumują się');
      return {
        gross: t.gross + BigInt(line.gross_minor),
        net: t.net + BigInt(line.net_minor),
        vat: t.vat + BigInt(line.vat_minor),
      };
    },
    { gross: 0n, net: 0n, vat: 0n },
  );
  if (!/^(0|[1-9][0-9]*)$/.test(String(expectedGross)) || totals.gross !== BigInt(expectedGross))
    throw new Error('Pozycje faktury nie sumują się do zamówienia');
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
export function localInvoiceRequestHash(
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
