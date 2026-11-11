import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { z } from 'zod';
import { ensure, Problem } from './errors';
// PayU REST API 2.1 values shared by the client, the notification verifier and the fake.
// Shapes follow the public PayU documentation; items marked "unverified" wait for a sandbox check
// (docs/parity/PAYMENT-PAYU-20261025.md, "Pytania do sandboxa").
export const PAYU_ENDPOINTS = {
  sandbox: 'https://secure.snd.payu.com',
  production: 'https://secure.payu.com',
} as const;
export type PayuMode = keyof typeof PAYU_ENDPOINTS;
// API calls go only to these two hosts; anything else is refused before the transport sees it.
export const PAYU_API_HOSTS: Record<PayuMode, string> = {
  sandbox: 'secure.snd.payu.com',
  production: 'secure.payu.com',
};
export const PAYU_CURRENCIES = ['PLN', 'EUR'] as const;
export type PayuCurrency = (typeof PAYU_CURRENCIES)[number];
export const PAYU_ORDER_STATUSES = ['NEW', 'PENDING', 'WAITING_FOR_CONFIRMATION', 'COMPLETED', 'CANCELED'] as const;
export type PayuOrderStatus = (typeof PAYU_ORDER_STATUSES)[number];
export const PAYU_TERMINAL = new Set<PayuOrderStatus>(['COMPLETED', 'CANCELED']);
// Forward-only order of the PayU lifecycle; a lower rank after a higher one is an out-of-order delivery.
export const payuStatusRank = (s: PayuOrderStatus) =>
  ({ NEW: 0, PENDING: 1, WAITING_FOR_CONFIRMATION: 2, COMPLETED: 3, CANCELED: 3 })[s];
export const PAYU_REFUND_STATUSES = ['PENDING', 'FINALIZED', 'CANCELED'] as const;
export type PayuRefundStatus = (typeof PAYU_REFUND_STATUSES)[number];
export const PAYU_MAX_AMOUNT = 999_999_999; // grosze; unverified upper bound per order
export const PAYU_MAX_RESPONSE_BYTES = 1_048_576;
export const PAYU_MAX_NOTIFICATION_BYTES = 262_144;
export const PAYU_TOKEN_SKEW_MS = 60_000;

const noControl = (v: string) => !/[\x00-\x1f\x7f]/.test(v);
const line = (min: number, max: number) => z.string().trim().min(min).max(max).refine(noControl, 'Niedozwolone znaki');
const grosze = (min: number) => z.number().int().min(min).max(PAYU_MAX_AMOUNT);
// Our own key: session id (+ attempt). PayU accepts up to 1024 characters; we keep it short and URL-safe.
export const payuExtId = z.string().regex(/^[A-Za-z0-9._:-]{1,100}$/, 'Nieprawidłowy identyfikator extOrderId');
export const payuOrderId = z.string().regex(/^[A-Za-z0-9]{6,64}$/, 'Nieprawidłowy identyfikator zamówienia PayU');
export const payuRefundId = z.string().regex(/^[A-Za-z0-9]{1,64}$/, 'Nieprawidłowy identyfikator zwrotu PayU');
const httpsUrl = z
  .string()
  .max(1024)
  .refine((v) => {
    try {
      const u = new URL(v);
      return u.protocol === 'https:' && !u.username && !u.password && !u.hash;
    } catch {
      return false;
    }
  }, 'Wymagany adres HTTPS bez danych logowania');
export const payuOrderInput = z
  .strictObject({
    extOrderId: payuExtId,
    description: line(1, 255),
    currency: z.enum(PAYU_CURRENCIES, 'PayU obsługuje tu tylko PLN i EUR'),
    amount: grosze(1),
    customerIp: z.string().refine((v) => isIP(v) !== 0, 'Nieprawidłowy adres IP kupującego'),
    notifyUrl: httpsUrl,
    continueUrl: httpsUrl,
    buyer: z.strictObject({
      email: z.email().max(255),
      phone: z.string().regex(/^\+?\d{6,15}$/, 'Nieprawidłowy telefon').optional(),
      firstName: line(1, 100).optional(),
      lastName: line(1, 100).optional(),
      language: z.enum(['pl', 'en', 'de', 'cs', 'sk']).default('pl'),
    }),
    products: z
      .array(z.strictObject({ name: line(1, 255), unitPrice: grosze(0), quantity: z.number().int().min(1).max(100_000) }))
      .min(1)
      .max(500),
    validitySeconds: z.number().int().min(60).max(86_400 * 7).optional(),
  })
  .refine(
    (o) => o.products.reduce((s, p) => s + p.unitPrice * p.quantity, 0) === o.amount,
    'Suma produktów nie zgadza się z kwotą płatności',
  );
export type PayuOrderInput = z.input<typeof payuOrderInput>;
export type PayuOrder = z.output<typeof payuOrderInput>;
export const payuRefundInput = z.strictObject({
  extRefundId: payuExtId,
  description: line(1, 255),
  currency: z.enum(PAYU_CURRENCIES),
  // Omitted amount = full refund of what is still refundable.
  amount: grosze(1).optional(),
});
export type PayuRefundInput = z.input<typeof payuRefundInput>;

export function parsePayu<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const r = schema.safeParse(input);
  if (!r.success) throw new Problem(422, r.error.issues[0]?.message ?? 'Nieprawidłowe dane płatności', 'PAYU_INPUT');
  return r.data;
}
// The exact body we send for one extOrderId; a different body under the same key is a conflict.
export function payuFingerprint(v: unknown): string {
  return createHash('sha256').update(JSON.stringify(v)).digest('hex');
}
export function payuApiUrl(mode: PayuMode, path: string): string {
  ensure(path.startsWith('/') && !path.includes('..'), 422, 'Nieprawidłowa ścieżka API PayU');
  const u = new URL(PAYU_ENDPOINTS[mode] + path);
  assertPayuApiUrl(u.href, mode);
  return u.href;
}
export function assertPayuApiUrl(url: string, mode: PayuMode): void {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Problem(422, 'Nieprawidłowy adres PayU', 'PAYU_HOST');
  }
  ensure(
    u.protocol === 'https:' && !u.username && !u.password && (!u.port || u.port === '443') && u.hostname === PAYU_API_HOSTS[mode],
    422,
    'Adres PayU musi być oficjalnym hostem HTTPS zgodnym ze środowiskiem',
  );
}
// redirectUri is where the buyer pays. Unverified: the sandbox pay page may live on another *.snd.payu.com host.
export function payuRedirectOk(url: unknown, mode: PayuMode): url is string {
  if (typeof url !== 'string' || url.length > 2048) return false;
  try {
    const u = new URL(url);
    const sandbox = u.hostname === 'snd.payu.com' || u.hostname.endsWith('.snd.payu.com');
    return (
      u.protocol === 'https:' &&
      !u.username &&
      !u.password &&
      (!u.port || u.port === '443') &&
      (u.hostname === 'payu.com' || u.hostname.endsWith('.payu.com')) &&
      sandbox === (mode === 'sandbox')
    );
  } catch {
    return false;
  }
}
export const payuGrosze = (v: unknown): number | null => {
  const n = typeof v === 'string' && /^\d{1,12}$/.test(v) ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isSafeInteger(n) && n >= 0 && n <= PAYU_MAX_AMOUNT ? n : null;
};
export const payuOrderStatus = (v: unknown): PayuOrderStatus | null =>
  PAYU_ORDER_STATUSES.includes(v as PayuOrderStatus) ? (v as PayuOrderStatus) : null;
export const payuRefundStatus = (v: unknown): PayuRefundStatus | null =>
  PAYU_REFUND_STATUSES.includes(v as PayuRefundStatus) ? (v as PayuRefundStatus) : null;
export const payuCurrency = (v: unknown): PayuCurrency | null =>
  PAYU_CURRENCIES.includes(v as PayuCurrency) ? (v as PayuCurrency) : null;

export function invalidPayu(uncertain = false): never {
  if (uncertain)
    throw new Problem(504, 'Nieczytelna odpowiedź PayU po wysłaniu operacji; wynik niepewny — uzgodnij przed ponowieniem', 'PAYU_UNCERTAIN');
  throw new Problem(502, 'PayU zwrócił nieczytelną odpowiedź', 'PAYU_INVALID_RESPONSE');
}
// PayU error bodies: {status:{statusCode, code?, codeLiteral?, statusDesc?}} or OAuth {error, error_description}.
// Provider text never leaves this module; only a classified Polish message and a sanitized code do.
export function payuProblem(http: number, body: unknown): Problem {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, any>;
  const statusCode = String(b.status?.statusCode ?? b.error ?? '');
  const literal = String(b.status?.codeLiteral ?? '');
  const safe = /^[A-Z0-9_]{1,60}$/i.test(statusCode) ? statusCode : 'unknown';
  const p = (status: number, message: string, kind: string) => new Problem(status, message, `${kind}:${safe}`);
  if (http === 401 || statusCode === 'invalid_client' || statusCode === 'UNAUTHORIZED')
    return p(401, 'PayU odrzucił dane uwierzytelniające POS (client_id/client_secret); sprawdź konfigurację', 'PAYU_AUTH');
  if (http === 403 || statusCode === 'UNAUTHORIZED_REQUEST')
    return p(403, 'PayU odmówił dostępu do tej operacji dla tego punktu płatności (POS)', 'PAYU_FORBIDDEN');
  if (http === 429) return p(429, 'PayU ograniczył liczbę zapytań; spróbuj później', 'PAYU_RATE_LIMIT');
  if (http >= 500) return p(502, `PayU jest chwilowo niedostępny (HTTP ${http})`, 'PAYU_UNAVAILABLE');
  if (http === 404 || statusCode === 'DATA_NOT_FOUND')
    return p(404, 'PayU nie zna tego zamówienia płatności lub zwrotu', 'PAYU_NOT_FOUND');
  if (statusCode === 'ERROR_ORDER_NOT_UNIQUE')
    return p(409, 'PayU ma już płatność z tym identyfikatorem extOrderId', 'PAYU_DUPLICATE_EXT_ORDER');
  if (/NO_BALANCE|INSUFFICIENT/i.test(literal))
    return p(422, 'Saldo PayU nie wystarcza do wykonania zwrotu', 'PAYU_REFUND_BALANCE');
  if (/AMOUNT|REFUND/i.test(literal))
    return p(422, 'PayU odrzucił kwotę lub warunki zwrotu', 'PAYU_REFUND_REJECTED');
  if (statusCode === 'OPENPAYU_BUSINESS_ERROR' || statusCode === 'BUSINESS_ERROR')
    return p(422, 'PayU odrzucił operację z przyczyn biznesowych (np. stan zamówienia)', 'PAYU_BUSINESS');
  if (/^(OPENPAYU_)?ERROR_(VALUE_INVALID|VALUE_MISSING|SYNTAX)$/.test(statusCode) || statusCode === 'invalid_request' || http === 400)
    return p(422, 'PayU odrzucił dane płatności', 'PAYU_VALIDATION');
  return p(502, 'PayU zwrócił nieoczekiwany błąd', 'PAYU_ERROR');
}
