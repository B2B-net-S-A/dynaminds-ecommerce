import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { SMSAPI_STATUS_NAMES, type SmsDeliveryCode } from './sms-delivery-status';
export { SMSAPI_STATUS_NAMES, type SmsDeliveryCode };
// SMSAPI.pl callback/status contract: https://www.smsapi.pl/docs/#raporty-callback
// No provider HMAC is documented, so two independent checks gate a report:
// the actual network peer (IP allowlist) AND a per-endpoint secret path segment
// that only this app and SMSAPI (via notify_url) know. The secret lives only in
// the channel's encrypted credentials (callback_token), never in plaintext columns.
export const SMSAPI_CALLBACK_IPS = Object.freeze([
  '89.174.81.98', '91.185.187.219', '213.189.53.211', '31.186.83.18', '212.91.26.253',
]);
export type DeliveryEvent = {
  providerId: string; code: SmsDeliveryCode; sentAt: number; doneAt: number;
  account: string; recipient: string; idx: string | null;
};
export class DeliveryRefusal extends Error {
  constructor(public status: number, message = 'SMS callback refused') { super(message); }
  get statusCode(){return this.status;}
}
export function requireSmsApiPeer(peer: string | undefined) {
  const address = peer?.startsWith('::ffff:') ? peer.slice(7) : peer;
  if (!address || !SMSAPI_CALLBACK_IPS.includes(address)) throw new DeliveryRefusal(403);
}
// 32 random bytes, base64url without padding.
export const SMSAPI_CALLBACK_TOKEN = /^[A-Za-z0-9_-]{43}$/;
export function newSmsApiCallbackToken() {
  return randomBytes(32).toString('base64url');
}
// Constant-time on fixed-length digests; an endpoint without a token (created
// before this check existed) fails closed and must be configured again.
export function requireSmsApiCallbackToken(expected: unknown, presented: unknown) {
  if (typeof expected !== 'string' || !SMSAPI_CALLBACK_TOKEN.test(expected) || typeof presented !== 'string')
    throw new DeliveryRefusal(404);
  const a = createHash('sha256').update(expected).digest(), b = createHash('sha256').update(presented).digest();
  if (!timingSafeEqual(a, b)) throw new DeliveryRefusal(404);
}
export function smsApiNotifyUrl(callbackUrl: string, token: unknown) {
  if (typeof token !== 'string' || !SMSAPI_CALLBACK_TOKEN.test(token)) throw new DeliveryRefusal(409, 'Endpoint SMS bez tokenu callbacku — skonfiguruj go ponownie');
  return callbackUrl + '/' + token;
}
export function parseSmsApiCallback(input: unknown): DeliveryEvent[] {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new DeliveryRefusal(422);
  const fields = input as Record<string, unknown>;
  const read = (name: string, optional = false) => {
    const property = Object.getOwnPropertyDescriptor(fields, name);
    if (property && !Object.hasOwn(property, 'value')) throw new DeliveryRefusal(422);
    const value = property?.value;
    if (optional && value === undefined) return null;
    if (typeof value !== 'string' || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value))
      throw new DeliveryRefusal(422);
    return value.split(',');
  };
  const ids = read('MsgId')!;
  if (ids.length < 1 || ids.length > 5) throw new DeliveryRefusal(422);
  const names = ['status', 'sent_at', 'donedate', 'username', 'to'] as const;
  const values = Object.fromEntries(names.map(name => [name, read(name)!])) as Record<typeof names[number], string[]>;
  const idx = read('idx', true), statusNames = read('status_name', true);
  if (Object.values(values).some(v => v.length !== ids.length) || idx && idx.length !== ids.length || statusNames && statusNames.length !== ids.length)
    throw new DeliveryRefusal(422);
  const epoch = (value: string) => {
    if (!/^(0|[1-9]\d{0,9})$/.test(value)) throw new DeliveryRefusal(422);
    const n = Number(value);
    if (!Number.isSafeInteger(n)) throw new DeliveryRefusal(422);
    return n;
  };
  return ids.map((providerId, i) => {
    if (!/^[^\s,\u007f]{1,32}$/.test(providerId) || !/^\d{3}$/.test(values.status[i])) throw new DeliveryRefusal(422);
    const code = Number(values.status[i]) as SmsDeliveryCode;
    if (!Object.hasOwn(SMSAPI_STATUS_NAMES, code) || statusNames && statusNames[i] !== SMSAPI_STATUS_NAMES[code]) throw new DeliveryRefusal(422);
    const sentAt = epoch(values.sent_at[i]), doneAt = epoch(values.donedate[i]);
    if (sentAt === 0 || doneAt !== 0 && doneAt < sentAt || code === 404 && doneAt === 0)
      throw new DeliveryRefusal(422);
    if (!/^[1-9]\d{7,14}$/.test(values.to[i]) || !values.username[i] || values.username[i].length > 200 || idx && idx[i].length > 255)
      throw new DeliveryRefusal(422);
    return { providerId, code, sentAt, doneAt, account: values.username[i], recipient: values.to[i], idx: idx ? idx[i] : null };
  });
}
const finalCodes = new Set<SmsDeliveryCode>([402, 404, 405, 406, 407, 412]);
const progress: Partial<Record<SmsDeliveryCode, number>> = { 409: 0, 410: 1, 411: 1, 403: 2 };
export type DeliveryState = { code: SmsDeliveryCode | null; doneAt: number; needsReconciliation: boolean };
export function reconcileDelivery(current: DeliveryState, event: DeliveryEvent): {
  action: 'applied' | 'duplicate' | 'stale' | 'conflict'; state: DeliveryState;
} {
  if (current.code === event.code && current.doneAt === event.doneAt) return { action: 'duplicate', state: current };
  if (current.code !== null && finalCodes.has(current.code)) {
    if (!finalCodes.has(event.code) || event.doneAt < current.doneAt) return { action: 'stale', state: current };
    // Conflicting final reports are retained for reconciliation; never overwrite delivery blindly.
    return { action: 'conflict', state: { ...current, needsReconciliation: true } };
  }
  if (current.doneAt && event.doneAt && event.doneAt < current.doneAt) return { action: 'stale', state: current };
  if (!finalCodes.has(event.code) && current.code !== null &&
      progress[current.code] !== undefined && progress[event.code] !== undefined && progress[event.code]! < progress[current.code]!)
    return { action: 'stale', state: current };
  return { action: 'applied', state: { code: event.code, doneAt: event.doneAt, needsReconciliation: event.code === 401 || event.code === 408 } };
}
