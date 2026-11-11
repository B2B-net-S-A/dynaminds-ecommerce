import { createHash } from 'node:crypto';
import type { Transport } from './integrations';
import { PAYU_ENDPOINTS, type PayuMode, type PayuOrderStatus, type PayuRefundStatus } from './payment-payu-values';
// Local, stateful stand-in for PayU REST API 2.1. SYNTHETIC: response shapes are authored from the public
// PayU documentation, not recorded from PayU. No network; used by tests and later by the local simulation.
export const PAYU_FAKE_POS = '300001';
export const PAYU_FAKE_SECRET = 'synthetic-payu-client-secret';
export const PAYU_FAKE_SECOND_KEY = 'synthetic-payu-second-key';
export type PayuFakeFailure =
  | { kind: 'hang' }
  | { kind: 'throw' }
  | { kind: 'http'; status: number; body?: unknown; retryAfter?: string }
  | { kind: 'raw'; status: number; body: string }
  // ACK loss: the fake commits the mutation, then the answer never arrives (or arrives as a bare 500).
  | { kind: 'commit_then_hang' }
  | { kind: 'commit_then_500' };
export interface PayuFakeOrder {
  orderId: string;
  extOrderId: string;
  status: PayuOrderStatus;
  totalAmount: number;
  currencyCode: string;
  orderCreateDate: string;
  paymentId: string | null;
  request: Record<string, any>;
}
export interface PayuFakeRefund {
  refundId: string;
  extRefundId: string;
  amount: number;
  currencyCode: string;
  status: PayuRefundStatus;
  description: string;
  creationDateTime: string;
}
export interface PayuFakeOptions {
  mode?: PayuMode;
  posId?: string;
  clientSecret?: string;
  secondKey?: string;
  tokenTtlSeconds?: number;
  now?: () => number;
  // Eight [A-Z0-9] in the middle of every fake orderId; a per-process tag keeps ids unique across restarts.
  orderTag?: string;
}
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const err = (status: number, statusCode: string, codeLiteral?: string) =>
  json(status, { status: { statusCode, ...(codeLiteral ? { codeLiteral } : {}), statusDesc: 'SYNTHETIC' } });
export function createPayuFake(opts: PayuFakeOptions = {}) {
  const mode = opts.mode ?? 'sandbox';
  const base = PAYU_ENDPOINTS[mode];
  const posId = opts.posId ?? PAYU_FAKE_POS;
  const secret = opts.clientSecret ?? PAYU_FAKE_SECRET;
  const secondKey = opts.secondKey ?? PAYU_FAKE_SECOND_KEY;
  const ttl = opts.tokenTtlSeconds ?? 43199;
  const now = opts.now ?? (() => Date.now());
  const orderTag = opts.orderTag ?? 'GUEST000';
  if (!/^[A-Z0-9]{8}$/.test(orderTag)) throw new Error('SYNTHETIC fake: orderTag must be 8 [A-Z0-9]');
  const tokens = new Map<string, number>();
  const orders = new Map<string, PayuFakeOrder>();
  const refunds = new Map<string, PayuFakeRefund[]>();
  const failures: { failure: PayuFakeFailure; route?: string }[] = [];
  const calls: { method: string; path: string; token: string | null }[] = [];
  let seq = 0;
  const hang = (signal?: AbortSignal | null) =>
    new Promise<Response>((_, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted'))));
  const view = (o: PayuFakeOrder) => ({
    orderId: o.orderId,
    extOrderId: o.extOrderId,
    orderCreateDate: o.orderCreateDate,
    notifyUrl: o.request.notifyUrl,
    customerIp: o.request.customerIp,
    merchantPosId: posId,
    description: o.request.description,
    currencyCode: o.currencyCode,
    totalAmount: String(o.totalAmount),
    status: o.status,
    products: o.request.products,
  });
  const refundView = (r: PayuFakeRefund) => ({ ...r, amount: String(r.amount), statusDateTime: r.creationDateTime });
  const stamp = () => new Date(now()).toISOString();
  function handle(method: string, path: string, body: string, auth: string | null): Response {
    if (method === 'POST' && path === '/pl/standard/user/oauth/authorize') {
      const f = new URLSearchParams(body);
      if (f.get('grant_type') !== 'client_credentials' || f.get('client_id') !== posId || f.get('client_secret') !== secret)
        return json(401, { error: 'invalid_client', error_description: 'SYNTHETIC Bad client credentials' });
      const token = `synthetic-token-${++seq}`;
      tokens.set(token, now() + ttl * 1000);
      return json(200, { access_token: token, token_type: 'bearer', expires_in: ttl, grant_type: 'client_credentials' });
    }
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
    const expiry = token ? tokens.get(token) : undefined;
    if (!expiry || now() >= expiry) return err(401, 'UNAUTHORIZED');
    let m: RegExpMatchArray | null;
    if (method === 'POST' && path === '/api/v2_1/orders') {
      const req = JSON.parse(body);
      if (req.merchantPosId !== posId) return err(403, 'UNAUTHORIZED_REQUEST');
      if (!['PLN', 'EUR'].includes(req.currencyCode) || !/^\d+$/.test(req.totalAmount ?? '')) return err(400, 'ERROR_VALUE_INVALID');
      if ([...orders.values()].some((o) => o.extOrderId === req.extOrderId)) return err(400, 'ERROR_ORDER_NOT_UNIQUE');
      const orderId = `SYNTH${String(++seq).padStart(6, '0')}${orderTag}P01`;
      orders.set(orderId, {
        orderId,
        extOrderId: req.extOrderId,
        status: 'NEW',
        totalAmount: Number(req.totalAmount),
        currencyCode: req.currencyCode,
        orderCreateDate: stamp(),
        paymentId: null,
        request: req,
      });
      const redirectUri = `https://merch-prod.snd.payu.com/pay/?orderId=${orderId}&token=synthetic`;
      return json(302, { status: { statusCode: 'SUCCESS' }, redirectUri, orderId, extOrderId: req.extOrderId }, { Location: redirectUri });
    }
    if (method === 'GET' && (m = path.match(/^\/api\/v2_1\/orders\/ext\/([^/]+)$/))) {
      const ext = decodeURIComponent(m[1]);
      const found = [...orders.values()].filter((o) => o.extOrderId === ext);
      return found.length ? json(200, { orders: found.map(view), status: { statusCode: 'SUCCESS' } }) : err(404, 'DATA_NOT_FOUND');
    }
    if ((m = path.match(/^\/api\/v2_1\/orders\/([A-Za-z0-9]+)(\/refunds(?:\/([A-Za-z0-9]+))?)?$/))) {
      const o = orders.get(m[1]);
      if (!o) return err(404, 'DATA_NOT_FOUND');
      const list = refunds.get(o.orderId) ?? [];
      if (!m[2]) {
        if (method === 'GET')
          return json(200, {
            orders: [view(o)],
            status: { statusCode: 'SUCCESS' },
            properties: o.paymentId ? [{ name: 'PAYMENT_ID', value: o.paymentId }] : [],
          });
        if (method === 'DELETE') {
          if (o.status === 'COMPLETED' || o.status === 'CANCELED') return err(400, 'OPENPAYU_BUSINESS_ERROR');
          o.status = 'CANCELED';
          return json(200, { orderId: o.orderId, extOrderId: o.extOrderId, status: { statusCode: 'SUCCESS' } });
        }
      }
      if (m[2] && m[3] && method === 'GET') {
        const r = list.find((x) => x.refundId === m![3]);
        return r ? json(200, refundView(r)) : err(404, 'DATA_NOT_FOUND');
      }
      if (m[2] && !m[3] && method === 'GET') return json(200, { refunds: list.map(refundView) });
      if (m[2] && !m[3] && method === 'POST') {
        const req = JSON.parse(body).refund ?? {};
        if (o.status !== 'COMPLETED') return err(400, 'OPENPAYU_BUSINESS_ERROR');
        if (list.some((x) => x.extRefundId === req.extRefundId)) return err(400, 'ERROR_VALUE_INVALID', 'DUPLICATED_REFUND');
        const refunded = list.filter((x) => x.status !== 'CANCELED').reduce((s, x) => s + x.amount, 0);
        const amount = req.amount === undefined ? o.totalAmount - refunded : Number(req.amount);
        if (amount <= 0 || amount + refunded > o.totalAmount) return err(400, 'OPENPAYU_BUSINESS_ERROR', 'REFUND_AMOUNT_TOO_HIGH');
        const r: PayuFakeRefund = {
          refundId: String(5000000 + ++seq),
          extRefundId: req.extRefundId,
          amount,
          currencyCode: o.currencyCode,
          status: 'PENDING',
          description: req.description,
          creationDateTime: stamp(),
        };
        refunds.set(o.orderId, [...list, r]);
        return json(200, { orderId: o.orderId, refund: refundView(r), status: { statusCode: 'SUCCESS' } });
      }
    }
    return err(404, 'DATA_NOT_FOUND');
  }
  const transport: Transport = async (url, init) => {
    if (!url.startsWith(base + '/')) throw new Error('SYNTHETIC fake: foreign host ' + new URL(url).host);
    const u = new URL(url);
    const method = String(init.method ?? 'GET').toUpperCase();
    const headers = new Headers(init.headers);
    calls.push({ method, path: u.pathname, token: headers.get('authorization') });
    const at = failures.findIndex((f) => !f.route || `${method} ${u.pathname}`.startsWith(f.route));
    const failure = at >= 0 ? failures.splice(at, 1)[0].failure : null;
    if (failure?.kind === 'throw') throw new TypeError('fetch failed');
    if (failure?.kind === 'hang') return hang(init.signal);
    if (failure?.kind === 'http')
      return json(failure.status, failure.body ?? { status: { statusCode: 'SYNTHETIC' } }, failure.retryAfter ? { 'Retry-After': failure.retryAfter } : {});
    if (failure?.kind === 'raw') return new Response(failure.body, { status: failure.status });
    const res = handle(method, u.pathname, typeof init.body === 'string' ? init.body : '', headers.get('authorization'));
    if (failure?.kind === 'commit_then_hang') return hang(init.signal);
    if (failure?.kind === 'commit_then_500') return new Response('', { status: 500 });
    return res;
  };
  // Builds what PayU would POST to notifyUrl; the signature is hash(body + second key).
  function sign(body: string, algorithm: 'MD5' | 'SHA-256' = 'MD5', key = secondKey) {
    const signature = createHash(algorithm === 'MD5' ? 'md5' : 'sha256').update(body + key).digest('hex');
    return { 'OpenPayu-Signature': `sender=checkout;signature=${signature};algorithm=${algorithm};content=DOCUMENT` };
  }
  function orderNotification(orderId: string, algorithm: 'MD5' | 'SHA-256' = 'MD5') {
    const o = orders.get(orderId)!;
    const body = JSON.stringify({
      order: { ...view(o), buyer: o.request.buyer, payMethod: { type: 'PBL' } },
      localReceiptDateTime: stamp(),
      properties: o.paymentId ? [{ name: 'PAYMENT_ID', value: o.paymentId }] : [],
    });
    return { body, headers: sign(body, algorithm) };
  }
  return {
    transport,
    orders,
    refunds,
    calls,
    tokens,
    fail(failure: PayuFakeFailure, route?: string) {
      failures.push({ failure, route });
    },
    // Buyer actions happen on PayU's pay page; tests drive them directly.
    setStatus(orderId: string, status: PayuOrderStatus) {
      const o = orders.get(orderId)!;
      o.status = status;
      if (status === 'COMPLETED') o.paymentId ??= String(7000000000 + ++seq);
    },
    finalizeRefund(orderId: string, refundId: string) {
      const r = refunds.get(orderId)!.find((x) => x.refundId === refundId)!;
      r.status = 'FINALIZED';
    },
    revokeTokens() {
      tokens.clear();
    },
    sign,
    orderNotification,
  };
}
export type PayuFake = ReturnType<typeof createPayuFake>;
