import { setTimeout as sleepFor } from 'node:timers/promises';
import { ensure, Problem } from './errors';
import type { Transport } from './integrations';
import {
  PAYU_ENDPOINTS,
  PAYU_MAX_RESPONSE_BYTES,
  PAYU_TOKEN_SKEW_MS,
  invalidPayu,
  parsePayu,
  payuApiUrl,
  payuCurrency,
  payuFingerprint,
  payuGrosze,
  payuOrderId,
  payuOrderInput,
  payuOrderStatus,
  payuProblem,
  payuRedirectOk,
  payuRefundId,
  payuRefundInput,
  payuRefundStatus,
  payuExtId,
  type PayuCurrency,
  type PayuMode,
  type PayuOrderInput,
  type PayuOrderStatus,
  type PayuRefundInput,
  type PayuRefundStatus,
} from './payment-payu-values';
export * from './payment-payu-values';
// PayU REST API 2.1 client. Pure module: the caller supplies the transport (later the policy-guarded
// safeFetch, in tests the stateful fake from payment-payu-fake.ts). No DB, no routes, no real network here.
export interface PayuSettings {
  pos_id?: string;
  client_id?: string;
}
export interface PayuCredentials {
  client_secret?: string;
}
export interface PayuToken {
  accessToken: string;
  expiresAt: number;
}
export interface PayuOptions {
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<unknown>;
  now?: () => number;
  store?: PayuIdempotencyStore;
}
// Creation is claimed under extOrderId before any network call. Wiring replaces the in-memory store
// with the payment-session row (phase create_started / created).
export type PayuClaim = { state: 'new' } | { state: 'started' } | { state: 'done'; result: PayuCreated };
export interface PayuIdempotencyStore {
  claim(key: string, fingerprint: string): Promise<PayuClaim>;
  finish(key: string, result: PayuCreated): Promise<void>;
  release(key: string): Promise<void>;
}
export function memoryPayuStore(): PayuIdempotencyStore {
  const rows = new Map<string, { fingerprint: string; result?: PayuCreated }>();
  return {
    async claim(key, fingerprint) {
      const row = rows.get(key);
      if (!row) {
        rows.set(key, { fingerprint });
        return { state: 'new' };
      }
      ensure(row.fingerprint === fingerprint, 409, 'Identyfikator extOrderId użyto już z innymi danymi płatności');
      return row.result ? { state: 'done', result: row.result } : { state: 'started' };
    },
    async finish(key, result) {
      const row = rows.get(key);
      if (row) rows.set(key, { ...row, result });
    },
    async release(key) {
      rows.delete(key);
    },
  };
}
export interface PayuCreated {
  orderId: string;
  extOrderId: string;
  // null when the order was recovered by lookup after a lost response: PayU does not return the pay link
  // on reads, so the caller cancels this attempt and starts a new extOrderId (docs: "Utrata odpowiedzi").
  redirectUri: string | null;
  status: PayuOrderStatus;
  recovered: boolean;
  replayed: boolean;
}
export interface PayuOrderView {
  orderId: string;
  extOrderId: string | null;
  status: PayuOrderStatus;
  amount: number;
  currency: PayuCurrency;
  createdAt: string | null;
  paymentId: string | null;
}
export interface PayuRefundView {
  refundId: string;
  extRefundId: string | null;
  amount: number;
  currency: PayuCurrency;
  status: PayuRefundStatus;
  createdAt: string | null;
}
interface CallOptions {
  idempotent: boolean;
  body?: unknown;
  accept302?: boolean;
  notFoundEmpty?: boolean;
}
const retryable = new Set([429, 500, 502, 503, 504]);
const enc = encodeURIComponent;
export class PayU {
  readonly mode: PayuMode;
  readonly posId: string;
  private readonly clientId: string;
  private readonly timeoutMs: number;
  private readonly sleep: (ms: number) => Promise<unknown>;
  private readonly now: () => number;
  private readonly store: PayuIdempotencyStore;
  private token: PayuToken | null = null;
  private pending: Promise<PayuToken> | null = null;
  constructor(
    mode: string,
    settings: PayuSettings,
    private readonly credentials: PayuCredentials,
    private readonly transport: Transport,
    options: PayuOptions = {},
  ) {
    ensure(mode === 'sandbox' || mode === 'production', 422, 'Nieprawidłowe środowisko PayU (sandbox albo production)');
    this.mode = mode;
    ensure(/^\d{1,12}$/.test(settings.pos_id ?? ''), 422, 'Wymagany numer punktu płatności PayU (pos_id)');
    this.posId = settings.pos_id!;
    this.clientId = settings.client_id ?? this.posId;
    ensure(/^\d{1,12}$/.test(this.clientId), 422, 'Nieprawidłowy client_id PayU');
    ensure(
      typeof credentials.client_secret === 'string' && /^[\x21-\x7e]{8,200}$/.test(credentials.client_secret),
      422,
      'Wymagany client_secret PayU',
    );
    this.timeoutMs = options.timeoutMs ?? 12000;
    this.sleep = options.sleep ?? ((ms) => sleepFor(ms));
    this.now = options.now ?? (() => Date.now());
    this.store = options.store ?? memoryPayuStore();
  }
  get endpoint(): string {
    return PAYU_ENDPOINTS[this.mode];
  }
  private async send(url: string, init: RequestInit): Promise<Response> {
    const abort = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = globalThis.setTimeout(() => {
        abort.abort();
        reject(new Problem(504, 'timeout', 'PAYU_TIMEOUT'));
      }, this.timeoutMs);
    });
    try {
      return await Promise.race([this.transport(url, { ...init, redirect: 'manual', signal: abort.signal }), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
  private async readJson(res: Response, uncertain: boolean): Promise<unknown> {
    const reader = res.body?.getReader();
    if (!reader) return {};
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > PAYU_MAX_RESPONSE_BYTES) invalidPayu(uncertain);
        chunks.push(value);
      }
      const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
      return text.trim() ? JSON.parse(text) : {};
    } catch (e) {
      if (e instanceof Problem) throw e;
      invalidPayu(uncertain);
    } finally {
      await reader.cancel().catch(() => {});
    }
  }
  // Only idempotent calls (token, reads) are retried: 429/5xx, timeouts and network errors, Retry-After
  // capped at 5 s. Mutations get one attempt; a lost answer is PAYU_UNCERTAIN and is reconciled by a read.
  private async attempt(method: string, url: string, init: RequestInit, o: CallOptions): Promise<{ status: number; body: unknown }> {
    const attempts = o.idempotent ? 3 : 1;
    for (let i = 0; i < attempts; i++) {
      const last = i === attempts - 1;
      let res: Response;
      try {
        res = await this.send(url, { ...init, method });
      } catch {
        if (!last) {
          await this.sleep(250 * 2 ** i);
          continue;
        }
        if (!o.idempotent)
          throw new Problem(504, 'Brak odpowiedzi PayU po wysłaniu operacji; wynik niepewny — uzgodnij przed ponowieniem', 'PAYU_UNCERTAIN');
        throw new Problem(504, 'PayU nie odpowiedział w wyznaczonym czasie', 'PAYU_TIMEOUT');
      }
      if (retryable.has(res.status) && !last) {
        await res.body?.cancel().catch(() => {});
        const after = Number(res.headers.get('retry-after'));
        await this.sleep(Math.min(5000, Number.isFinite(after) && after > 0 ? after * 1000 : 250 * 2 ** i));
        continue;
      }
      if (res.status >= 300 && res.status < 400 && !(o.accept302 && res.status === 302)) {
        await res.body?.cancel().catch(() => {});
        throw new Problem(502, 'PayU odpowiedział przekierowaniem; połączenie odrzucone', 'PAYU_REDIRECT');
      }
      if (!o.idempotent && res.status >= 500) {
        await res.body?.cancel().catch(() => {});
        throw new Problem(504, 'PayU zwrócił błąd po wysłaniu operacji; wynik niepewny — uzgodnij przed ponowieniem', 'PAYU_UNCERTAIN');
      }
      // An unreadable success (2xx, or 302 on create) after a mutation is uncertain, not a refusal.
      return { status: res.status, body: await this.readJson(res, !o.idempotent && res.status < 400) };
    }
    throw new Problem(504, 'PayU nie odpowiedział w wyznaczonym czasie', 'PAYU_TIMEOUT');
  }
  private async fetchToken(): Promise<PayuToken> {
    const form = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.clientId,
      client_secret: this.credentials.client_secret!,
    });
    const { status, body } = await this.attempt(
      'POST',
      payuApiUrl(this.mode, '/pl/standard/user/oauth/authorize'),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: form.toString() },
      { idempotent: true },
    );
    if (status !== 200) throw payuProblem(status, body);
    const b = body as Record<string, unknown>;
    const ttl = Number(b.expires_in);
    if (typeof b.access_token !== 'string' || !/^[\x21-\x7e]{8,4096}$/.test(b.access_token) || !Number.isFinite(ttl) || ttl <= 0)
      invalidPayu();
    return { accessToken: b.access_token as string, expiresAt: this.now() + ttl * 1000 };
  }
  // Cached until expires_in minus a skew; concurrent callers share one token request.
  async accessToken(): Promise<string> {
    if (this.token && this.now() < this.token.expiresAt - PAYU_TOKEN_SKEW_MS) return this.token.accessToken;
    this.pending ??= this.fetchToken().finally(() => {
      this.pending = null;
    });
    this.token = await this.pending;
    return this.token.accessToken;
  }
  private async call(method: string, path: string, o: CallOptions): Promise<{ status: number; body: any }> {
    const url = payuApiUrl(this.mode, path);
    for (let auth = 0; auth < 2; auth++) {
      const token = await this.accessToken();
      const init: RequestInit = {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          ...(o.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(o.body === undefined ? {} : { body: JSON.stringify(o.body) }),
      };
      const r = await this.attempt(method, url, init, o);
      // 401 = token rejected before processing: drop the cached token and repeat once with a fresh one.
      if (r.status === 401 && auth === 0) {
        this.token = null;
        continue;
      }
      if (o.notFoundEmpty && r.status === 404) return r;
      if (r.status >= 400) throw payuProblem(r.status, r.body);
      return r;
    }
    throw new Problem(401, 'PayU odrzucił token dostępu', 'PAYU_AUTH');
  }
  async test(): Promise<{ environment: PayuMode; endpoint: string; pos_id: string; token_expires_at: string }> {
    await this.accessToken();
    return { environment: this.mode, endpoint: this.endpoint, pos_id: this.posId, token_expires_at: new Date(this.token!.expiresAt).toISOString() };
  }
  // At most one PayU order per extOrderId. Same key + same body replays the stored result; a lost
  // response or a duplicate-key answer is reconciled by GET /orders/ext/{extOrderId}, never re-sent.
  async createOrder(input: PayuOrderInput): Promise<PayuCreated> {
    const o = parsePayu(payuOrderInput, input);
    const body = {
      notifyUrl: o.notifyUrl,
      continueUrl: o.continueUrl,
      customerIp: o.customerIp,
      merchantPosId: this.posId,
      description: o.description,
      currencyCode: o.currency,
      totalAmount: String(o.amount),
      extOrderId: o.extOrderId,
      ...(o.validitySeconds ? { validityTime: String(o.validitySeconds) } : {}),
      buyer: { ...o.buyer },
      products: o.products.map((p) => ({ name: p.name, unitPrice: String(p.unitPrice), quantity: String(p.quantity) })),
    };
    const claim = await this.store.claim(o.extOrderId, payuFingerprint(body));
    if (claim.state === 'done') return { ...claim.result, replayed: true };
    if (claim.state === 'started') return this.recoverCreate(o.extOrderId, o.amount, o.currency);
    let r: { status: number; body: any };
    try {
      r = await this.call('POST', '/api/v2_1/orders', { idempotent: false, body, accept302: true });
    } catch (e) {
      if (e instanceof Problem && (e.code === 'PAYU_UNCERTAIN' || e.code?.startsWith('PAYU_DUPLICATE_EXT_ORDER')))
        return this.finish(o.extOrderId, await this.recoverCreate(o.extOrderId, o.amount, o.currency));
      // Definite refusal before any order existed: the key may be used again after correcting the input.
      if (e instanceof Problem && e.status < 500) await this.store.release(o.extOrderId);
      throw e;
    }
    const b = r.body ?? {};
    const code = String(b.status?.statusCode ?? '');
    if (!['SUCCESS', 'WARNING_CONTINUE_REDIRECT', 'WARNING_CONTINUE_3DS', 'WARNING_CONTINUE_CVV'].includes(code))
      return this.finish(o.extOrderId, await this.recoverCreate(o.extOrderId, o.amount, o.currency));
    if (!payuOrderId.safeParse(b.orderId).success || (b.extOrderId !== undefined && b.extOrderId !== o.extOrderId) || !payuRedirectOk(b.redirectUri, this.mode))
      return this.finish(o.extOrderId, await this.recoverCreate(o.extOrderId, o.amount, o.currency));
    return this.finish(o.extOrderId, {
      orderId: b.orderId,
      extOrderId: o.extOrderId,
      redirectUri: b.redirectUri,
      status: 'NEW',
      recovered: false,
      replayed: false,
    });
  }
  private async finish(key: string, result: PayuCreated): Promise<PayuCreated> {
    await this.store.finish(key, result);
    return result;
  }
  private async recoverCreate(extOrderId: string, amount: number, currency: PayuCurrency): Promise<PayuCreated> {
    const found = await this.ordersByExtOrderId(extOrderId);
    if (found.length === 0)
      throw new Problem(
        409,
        'PayU nie pokazuje płatności po utracie odpowiedzi; sprawdź ponownie, zanim utworzysz nową próbę',
        'PAYU_RECONCILE_ABSENT',
      );
    if (found.length > 1)
      throw new Problem(409, 'PayU ma kilka płatności z tym extOrderId; wymagane ręczne uzgodnienie', 'PAYU_RECONCILE_AMBIGUOUS');
    const [order] = found;
    if (order.amount !== amount || order.currency !== currency)
      throw new Problem(409, 'Płatność w PayU ma inną kwotę lub walutę niż sesja; nie przyjęto', 'PAYU_AMOUNT_MISMATCH');
    return { orderId: order.orderId, extOrderId, redirectUri: null, status: order.status, recovered: true, replayed: false };
  }
  private orderView(o: any): PayuOrderView {
    const status = payuOrderStatus(o?.status), amount = payuGrosze(o?.totalAmount), currency = payuCurrency(o?.currencyCode);
    if (!payuOrderId.safeParse(o?.orderId).success || !status || amount === null || !currency) invalidPayu();
    return {
      orderId: o.orderId,
      extOrderId: typeof o.extOrderId === 'string' ? o.extOrderId : null,
      status,
      amount,
      currency,
      createdAt: typeof o.orderCreateDate === 'string' ? o.orderCreateDate : null,
      paymentId: null,
    };
  }
  async order(orderId: string): Promise<PayuOrderView> {
    parsePayu(payuOrderId, orderId);
    const { body } = await this.call('GET', `/api/v2_1/orders/${enc(orderId)}`, { idempotent: true });
    const orders = Array.isArray(body?.orders) ? body.orders : [];
    if (orders.length !== 1 || orders[0]?.orderId !== orderId) invalidPayu();
    const paymentId = Array.isArray(body.properties) ? body.properties.find((p: any) => p?.name === 'PAYMENT_ID')?.value : null;
    return { ...this.orderView(orders[0]), paymentId: typeof paymentId === 'string' ? paymentId : null };
  }
  async ordersByExtOrderId(extOrderId: string): Promise<PayuOrderView[]> {
    parsePayu(payuExtId, extOrderId);
    const r = await this.call('GET', `/api/v2_1/orders/ext/${enc(extOrderId)}`, { idempotent: true, notFoundEmpty: true });
    if (r.status === 404) return [];
    const orders = Array.isArray(r.body?.orders) ? r.body.orders : invalidPayu();
    return orders.map((o: any) => this.orderView(o)).filter((o: PayuOrderView) => o.extOrderId === extOrderId);
  }
  // Only orders not yet COMPLETED can be cancelled; a paid order needs a refund instead.
  async cancel(orderId: string): Promise<{ orderId: string; status: 'CANCELED'; recovered: boolean }> {
    const before = await this.order(orderId);
    if (before.status === 'CANCELED') return { orderId, status: 'CANCELED', recovered: true };
    ensure(before.status !== 'COMPLETED', 409, 'Opłaconej płatności PayU nie można anulować; użyj zwrotu');
    try {
      await this.call('DELETE', `/api/v2_1/orders/${enc(orderId)}`, { idempotent: false });
    } catch (e) {
      if (!(e instanceof Problem && e.code === 'PAYU_UNCERTAIN')) throw e;
      const after = await this.order(orderId);
      if (after.status !== 'CANCELED') throw e;
      return { orderId, status: 'CANCELED', recovered: true };
    }
    return { orderId, status: 'CANCELED', recovered: false };
  }
  private refundView(r: any): PayuRefundView {
    const status = payuRefundStatus(r?.status), amount = payuGrosze(r?.amount), currency = payuCurrency(r?.currencyCode);
    if (!payuRefundId.safeParse(r?.refundId).success || !status || amount === null || !currency) invalidPayu();
    return {
      refundId: r.refundId,
      extRefundId: typeof r.extRefundId === 'string' ? r.extRefundId : null,
      amount,
      currency,
      status,
      createdAt: typeof r.creationDateTime === 'string' ? r.creationDateTime : null,
    };
  }
  async refunds(orderId: string): Promise<PayuRefundView[]> {
    parsePayu(payuOrderId, orderId);
    const r = await this.call('GET', `/api/v2_1/orders/${enc(orderId)}/refunds`, { idempotent: true, notFoundEmpty: true });
    if (r.status === 404) return [];
    return (Array.isArray(r.body?.refunds) ? r.body.refunds : invalidPayu()).map((x: any) => this.refundView(x));
  }
  async refundStatus(orderId: string, refundId: string): Promise<PayuRefundView> {
    parsePayu(payuOrderId, orderId);
    parsePayu(payuRefundId, refundId);
    const { body } = await this.call('GET', `/api/v2_1/orders/${enc(orderId)}/refunds/${enc(refundId)}`, { idempotent: true });
    const view = this.refundView(body?.refund ?? body);
    if (view.refundId !== refundId) invalidPayu();
    return view;
  }
  // Full (amount omitted) or partial refund of a COMPLETED order. The remaining refundable amount is
  // read first; an over-refund is refused locally without a POST. extRefundId makes the call replay-safe.
  async refund(orderId: string, input: PayuRefundInput): Promise<PayuRefundView & { replayed: boolean }> {
    const r = parsePayu(payuRefundInput, input);
    const order = await this.order(orderId);
    ensure(order.status === 'COMPLETED', 409, 'Zwrot jest możliwy tylko dla opłaconej płatności PayU');
    ensure(order.currency === r.currency, 422, 'Waluta zwrotu musi być walutą płatności');
    const existing = await this.refunds(orderId);
    const same = existing.find((x) => x.extRefundId === r.extRefundId);
    if (same) {
      ensure(r.amount === undefined || same.amount === r.amount, 409, 'Identyfikator zwrotu użyto już z inną kwotą');
      return { ...same, replayed: true };
    }
    const refunded = existing.filter((x) => x.status !== 'CANCELED').reduce((s, x) => s + x.amount, 0);
    const remaining = order.amount - refunded;
    const amount = r.amount ?? remaining;
    if (amount <= 0 || amount > remaining)
      throw new Problem(422, 'Kwota zwrotu przekracza kwotę pobraną pomniejszoną o wcześniejsze zwroty', 'PAYU_REFUND_EXCEEDS');
    let res: { body: any };
    try {
      res = await this.call('POST', `/api/v2_1/orders/${enc(orderId)}/refunds`, {
        idempotent: false,
        body: { refund: { description: r.description, amount: String(amount), extRefundId: r.extRefundId, currencyCode: r.currency } },
      });
    } catch (e) {
      if (!(e instanceof Problem && e.code === 'PAYU_UNCERTAIN')) throw e;
      const found = (await this.refunds(orderId)).find((x) => x.extRefundId === r.extRefundId);
      if (!found) throw e;
      return { ...found, replayed: true };
    }
    const view = this.refundView(res.body?.refund);
    if (view.amount !== amount || view.currency !== r.currency) invalidPayu(true);
    return { ...view, extRefundId: view.extRefundId ?? r.extRefundId, replayed: false };
  }
}
