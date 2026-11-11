// Pure rules of the PayU payment session (migration 242, docs/parity/PAYU242-20261027.md). No DB, no network:
// the status machine for a notification or a status read, the notification peer allow-list, the secret
// path token of the notification URL, the configuration input and the refundable amount.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { z } from 'zod';
import { Problem } from './errors';
import { PAYU_CURRENCIES, type PayuCurrency, type PayuMode } from './payment-payu-values';

export const PAYU242_STATUSES = ['NEW', 'PENDING', 'WAITING_FOR_CONFIRMATION', 'COMPLETED', 'CANCELED', 'REJECTED'] as const;
export type Payu242Status = (typeof PAYU242_STATUSES)[number];
export const PAYU242_OPEN = new Set<Payu242Status>(['NEW', 'PENDING', 'WAITING_FOR_CONFIRMATION']);
// REJECTED is local only: PayU refused to create the order, so no money can follow.
export const PAYU242_TERMINAL = new Set<Payu242Status>(['COMPLETED', 'CANCELED', 'REJECTED']);
const rank: Record<Payu242Status, number> = { NEW: 0, PENDING: 1, WAITING_FOR_CONFIRMATION: 2, COMPLETED: 3, CANCELED: 3, REJECTED: 3 };
// A session stays open for buyers this long; PayU gets the same validityTime.
export const PAYU242_SESSION_SECONDS = 1800;

export interface Payu242SessionState {
  extOrderId: string;
  providerOrderId: string | null;
  amount: number;
  currency: PayuCurrency;
  status: Payu242Status;
}
/** What PayU says about one order: a signed notification or a status read. */
export interface Payu242Observation {
  orderId: string;
  extOrderId: string | null;
  status: 'NEW' | 'PENDING' | 'WAITING_FOR_CONFIRMATION' | 'COMPLETED' | 'CANCELED';
  amount: number;
  currency: string;
  paymentId: string | null;
}
export type Payu242Decision =
  | { outcome: 'apply'; status: Payu242Status; providerOrderId: string; book: boolean; paymentId: string | null }
  | { outcome: 'duplicate' }
  | { outcome: 'ignored_terminal' }
  | { outcome: 'ignored_out_of_order' }
  // PayU reports a payment for a session it had already closed: nothing is booked automatically.
  | { outcome: 'conflict'; review: 'completed_after_canceled' }
  | { outcome: 'amount_mismatch'; review: 'amount_mismatch' }
  | { outcome: 'foreign' };

/** One observation against the stored session. Forward only; a booked payment is never undone here and a
 * closed session never books later. Runs under the session row lock, so a replay sees the new status. */
export function decidePayu242(s: Payu242SessionState, o: Payu242Observation): Payu242Decision {
  if ((o.extOrderId !== null && o.extOrderId !== s.extOrderId) || (s.providerOrderId !== null && o.orderId !== s.providerOrderId))
    return { outcome: 'foreign' };
  if (o.amount !== s.amount || o.currency !== s.currency) return { outcome: 'amount_mismatch', review: 'amount_mismatch' };
  if (o.status === s.status) return { outcome: 'duplicate' };
  if (PAYU242_TERMINAL.has(s.status))
    return s.status !== 'COMPLETED' && o.status === 'COMPLETED'
      ? { outcome: 'conflict', review: 'completed_after_canceled' }
      : { outcome: 'ignored_terminal' };
  if (rank[o.status] < rank[s.status]) return { outcome: 'ignored_out_of_order' };
  return { outcome: 'apply', status: o.status, providerOrderId: o.orderId, book: o.status === 'COMPLETED', paymentId: o.paymentId };
}

// PayU notification senders as published in the PayU documentation ("Notifications", IP addresses).
// Unverified against the sandbox (docs/parity/PAYU242-20261027.md, question 14).
export const PAYU242_NOTIFY_IPS: Readonly<Record<PayuMode, readonly string[]>> = Object.freeze({
  production: Object.freeze(['185.68.12.10', '185.68.12.11', '185.68.12.12', '185.68.12.26', '185.68.12.27', '185.68.12.28']),
  sandbox: Object.freeze(['185.68.14.10', '185.68.14.11', '185.68.14.12', '185.68.14.26', '185.68.14.27', '185.68.14.28']),
});
/** The actual TCP peer (never X-Forwarded-For) must be a PayU sender of the configured environment. */
export function payu242PeerAllowed(peer: string | undefined | null, mode: PayuMode): boolean {
  const address = typeof peer === 'string' && peer.startsWith('::ffff:') ? peer.slice(7) : peer;
  return typeof address === 'string' && isIP(address) !== 0 && PAYU242_NOTIFY_IPS[mode].includes(address);
}

// The notification URL carries a secret segment (32 random bytes, base64url) kept only in the encrypted
// configuration: a request reaches the signature check only with the right configuration id and token.
export const PAYU242_TOKEN = /^[A-Za-z0-9_-]{43}$/;
export const newPayu242Secret = () => randomBytes(32).toString('base64url');
const digest = (v: string) => createHash('sha256').update(v, 'utf8').digest();
export const payu242Sha256 = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
export function payu242SecretMatches(expected: unknown, presented: unknown): boolean {
  if (typeof expected !== 'string' || !PAYU242_TOKEN.test(expected) || typeof presented !== 'string' || !PAYU242_TOKEN.test(presented))
    return false;
  return timingSafeEqual(digest(expected), digest(presented));
}
/** Return-page secret: only its sha256 is stored with the session. */
export function payu242ReturnSecretMatches(storedSha256: unknown, presented: unknown): boolean {
  if (typeof storedSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(storedSha256) || typeof presented !== 'string' || !PAYU242_TOKEN.test(presented))
    return false;
  return timingSafeEqual(Buffer.from(storedSha256, 'hex'), digest(presented));
}

const secret = z.string().regex(/^[\x21-\x7e]{8,200}$/, 'Klucz musi mieć 8–200 drukowalnych znaków ASCII');
export const payu242ConfigInput = z.strictObject({
  environment: z.enum(['sandbox', 'production']),
  pos_id: z.string().regex(/^\d{1,12}$/, 'Numer POS to 1–12 cyfr'),
  client_id: z.string().regex(/^\d{1,12}$/, 'client_id to 1–12 cyfr').optional(),
  public_origin: z.string().max(200),
  // Write-only. On update an omitted secret keeps the stored one.
  client_secret: secret.optional(),
  second_key: secret.optional(),
  enabled: z.boolean().default(true),
  version: z.number().int().positive().optional(),
});
export type Payu242ConfigInput = z.infer<typeof payu242ConfigInput>;
/** The public HTTPS origin PayU sends notifications to and returns the buyer to. Plain HTTP is accepted only
 * for a loopback name while the local PayU simulation runs (nothing leaves the machine then). */
export function payu242PublicOrigin(value: string, simulation: boolean): string {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new Problem(422, 'Adres publiczny sklepu musi być pełnym adresem, np. https://sklep.example.pl');
  }
  const loopback = u.hostname === 'localhost' || u.hostname.endsWith('.localhost') || u.hostname === '127.0.0.1';
  const schemeOk = u.protocol === 'https:' || (simulation && loopback && u.protocol === 'http:');
  if (!schemeOk || u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== ''))
    throw new Problem(422, 'Adres publiczny sklepu musi być adresem HTTPS bez ścieżki, parametrów i danych logowania');
  return u.origin;
}

export interface Payu242RefundRow {
  amount: number;
  status: string;
}
/** What may still go back to the buyer through PayU for one completed session: the session amount minus
 * refunds that are started, pending or finalized (a refused or cancelled refund frees its amount). */
export function payu242Refundable(sessionAmount: number, refunds: readonly Payu242RefundRow[]): number {
  const taken = refunds.filter((r) => !['CANCELED', 'refused'].includes(r.status)).reduce((s, r) => s + r.amount, 0);
  return Math.max(0, sessionAmount - taken);
}
export const payu242Currency = (v: unknown): PayuCurrency | null =>
  PAYU_CURRENCIES.includes(v as PayuCurrency) ? (v as PayuCurrency) : null;
