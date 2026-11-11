// SMSAPI.pl report status codes (https://www.smsapi.pl/docs/#raporty-callback). Kept free of Node
// imports because web/sms-delivery.tsx loads it in the browser; server/sms-delivery.ts re-exports it.
export const SMSAPI_STATUS_NAMES = {
  401: 'NOT_FOUND', 402: 'EXPIRED', 403: 'SENT', 404: 'DELIVERED',
  405: 'UNDELIVERED', 406: 'FAILED', 407: 'REJECTED', 408: 'UNKNOWN',
  409: 'QUEUE', 410: 'ACCEPTED', 411: 'RENEWAL', 412: 'STOP',
} as const;
export type SmsDeliveryCode = keyof typeof SMSAPI_STATUS_NAMES;
