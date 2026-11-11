import { createHash, timingSafeEqual } from 'node:crypto';
import { Problem } from './errors';
import {
  PAYU_MAX_NOTIFICATION_BYTES,
  PAYU_TERMINAL,
  payuCurrency,
  payuGrosze,
  payuOrderStatus,
  payuRefundStatus,
  payuStatusRank,
  type PayuCurrency,
  type PayuOrderStatus,
  type PayuRefundStatus,
} from './payment-payu-values';
// PayU notifications (POST to notifyUrl). The header OpenPayu-Signature carries
// "sender=checkout;signature=<hex>;algorithm=MD5|SHA-256;content=DOCUMENT"; the expected value is
// hash(raw body + second key). The raw body must be the exact bytes received, before any JSON parse.
export type PayuSignatureAlgorithm = 'MD5' | 'SHA-256';
export interface PayuSignature {
  signature: string;
  algorithm: PayuSignatureAlgorithm;
  sender: string | null;
}
export type PayuNotification =
  | {
      kind: 'order';
      orderId: string;
      extOrderId: string;
      status: PayuOrderStatus;
      amount: number;
      currency: PayuCurrency;
      paymentId: string | null;
    }
  | {
      kind: 'refund';
      orderId: string;
      extOrderId: string | null;
      refundId: string;
      extRefundId: string | null;
      status: PayuRefundStatus;
      amount: number;
      currency: PayuCurrency;
    };
const signatureProblem = () =>
  new Problem(401, 'Podpis powiadomienia PayU jest nieprawidłowy; powiadomienie odrzucono', 'PAYU_SIGNATURE');
export function parsePayuSignature(header: string | null | undefined): PayuSignature {
  if (typeof header !== 'string' || header.length > 512) throw signatureProblem();
  const parts = new Map<string, string>();
  for (const piece of header.split(';')) {
    const at = piece.indexOf('=');
    if (at > 0) parts.set(piece.slice(0, at).trim().toLowerCase(), piece.slice(at + 1).trim());
  }
  const raw = (parts.get('algorithm') ?? '').toUpperCase();
  const algorithm: PayuSignatureAlgorithm | null = raw === 'MD5' ? 'MD5' : raw === 'SHA-256' || raw === 'SHA256' ? 'SHA-256' : null;
  const signature = (parts.get('signature') ?? '').toLowerCase();
  const length = algorithm === 'MD5' ? 32 : 64;
  if (!algorithm || !new RegExp(`^[a-f0-9]{${length}}$`).test(signature)) throw signatureProblem();
  return { signature, algorithm, sender: parts.get('sender') ?? null };
}
// Constant-time comparison of equal-length hex digests; the expected digest is always computed.
export function payuSignatureValid(rawBody: Uint8Array | string, header: string | null | undefined, secondKey: string): boolean {
  let parsed: PayuSignature;
  try {
    parsed = parsePayuSignature(header);
  } catch {
    return false;
  }
  if (!secondKey) return false;
  const expected = createHash(parsed.algorithm === 'MD5' ? 'md5' : 'sha256')
    .update(Buffer.concat([Buffer.from(rawBody), Buffer.from(secondKey, 'utf8')]))
    .digest();
  const given = Buffer.from(parsed.signature, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}
const header = (headers: Headers | Record<string, string | undefined>, name: string) =>
  headers instanceof Headers ? headers.get(name) : (Object.entries(headers).find(([k]) => k.toLowerCase() === name)?.[1] ?? null);
// Verifies, then parses. Nothing from an unsigned or oversized body is interpreted.
export function verifyPayuNotification(
  rawBody: Uint8Array | string,
  headers: Headers | Record<string, string | undefined>,
  secondKey: string,
): PayuNotification {
  const bytes = Buffer.from(rawBody);
  if (bytes.length === 0 || bytes.length > PAYU_MAX_NOTIFICATION_BYTES)
    throw new Problem(413, 'Powiadomienie PayU ma nieprawidłowy rozmiar', 'PAYU_NOTIFICATION_SIZE');
  const signature = header(headers, 'openpayu-signature') ?? header(headers, 'x-openpayu-signature');
  if (!payuSignatureValid(bytes, signature, secondKey)) throw signatureProblem();
  let body: any;
  try {
    body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new Problem(400, 'Powiadomienie PayU nie jest poprawnym JSON', 'PAYU_NOTIFICATION_INVALID');
  }
  return parsePayuNotificationBody(body);
}
const invalid = () => new Problem(400, 'Powiadomienie PayU ma nieoczekiwany kształt', 'PAYU_NOTIFICATION_INVALID');
const id = (v: unknown, max = 64) => (typeof v === 'string' && new RegExp(`^[A-Za-z0-9._:-]{1,${max}}$`).test(v) ? v : null);
export function parsePayuNotificationBody(body: any): PayuNotification {
  if (!body || typeof body !== 'object') throw invalid();
  if (body.order && typeof body.order === 'object') {
    const o = body.order;
    const orderId = id(o.orderId), extOrderId = id(o.extOrderId, 100), status = payuOrderStatus(o.status);
    const amount = payuGrosze(o.totalAmount), currency = payuCurrency(o.currencyCode);
    if (!orderId || !extOrderId || !status || amount === null || !currency) throw invalid();
    const paymentId = Array.isArray(body.properties)
      ? (body.properties.find((p: any) => p?.name === 'PAYMENT_ID')?.value ?? null)
      : null;
    return { kind: 'order', orderId, extOrderId, status, amount, currency, paymentId: id(paymentId) };
  }
  if (body.refund && typeof body.refund === 'object') {
    const r = body.refund;
    const orderId = id(body.orderId), refundId = id(r.refundId), status = payuRefundStatus(r.status);
    const amount = payuGrosze(r.amount), currency = payuCurrency(r.currencyCode);
    if (!orderId || !refundId || !status || amount === null || !currency) throw invalid();
    return {
      kind: 'refund',
      orderId,
      extOrderId: id(body.extOrderId, 100),
      refundId,
      extRefundId: id(r.extRefundId, 100),
      status,
      amount,
      currency,
    };
  }
  throw invalid();
}
// Local payment session as the future payment-session table will hold it.
export interface PayuSession {
  extOrderId: string;
  orderId: string | null;
  amount: number;
  currency: PayuCurrency;
  status: PayuOrderStatus;
}
export type PayuDecision =
  | { outcome: 'apply'; status: PayuOrderStatus; orderId: string; bookReceipt: boolean; paymentId: string | null }
  | { outcome: 'duplicate' }
  | { outcome: 'ignored'; reason: 'terminal' | 'out_of_order' };
// Pure decision for one order notification against the stored session. Wiring runs it under a row lock
// and stores the result in the same transaction, so a replay sees the new status and becomes 'duplicate'.
export function decidePayuNotification(session: PayuSession, n: PayuNotification): PayuDecision {
  if (n.kind !== 'order') throw new Problem(422, 'To powiadomienie dotyczy zwrotu, nie płatności', 'PAYU_NOTIFICATION_KIND');
  if (n.extOrderId !== session.extOrderId || (session.orderId !== null && n.orderId !== session.orderId))
    throw new Problem(409, 'Powiadomienie PayU dotyczy innej płatności; nie zaksięgowano', 'PAYU_FOREIGN_NOTIFICATION');
  if (n.amount !== session.amount || n.currency !== session.currency)
    throw new Problem(409, 'Kwota lub waluta z powiadomienia PayU nie zgadza się z płatnością; nie zaksięgowano', 'PAYU_AMOUNT_MISMATCH');
  if (n.status === session.status) return { outcome: 'duplicate' };
  if (PAYU_TERMINAL.has(session.status)) return { outcome: 'ignored', reason: 'terminal' };
  if (payuStatusRank(n.status) < payuStatusRank(session.status)) return { outcome: 'ignored', reason: 'out_of_order' };
  return { outcome: 'apply', status: n.status, orderId: n.orderId, bookReceipt: n.status === 'COMPLETED', paymentId: n.paymentId };
}
