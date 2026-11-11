import { setTimeout } from 'node:timers/promises';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { decrypt } from './security';
import { ensure, Problem } from './errors';
import type { Transport } from './integrations';
import {
  EbayApiWait,
  ebayHasApiControl,
  ebayLimitedTransport,
  reserveEbayTransport,
  sendEbayReserved,
  releaseEbayApi,
  type EbayApiPermit,
} from './ebay-api-limits';
export const EBAY_READ_SCOPE = 'https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly';
export const EBAY_TRADING_SCOPE = 'https://api.ebay.com/oauth/api_scope';
export const EBAY_FULFILLMENT_WRITE_SCOPE = 'https://api.ebay.com/oauth/api_scope/sell.fulfillment';
export const EBAY_INVENTORY_SCOPE = 'https://api.ebay.com/oauth/api_scope/sell.inventory.readonly';
export const EBAY_ACCOUNT_READ_SCOPE = 'https://api.ebay.com/oauth/api_scope/sell.account.readonly';
export const EBAY_INVENTORY_WRITE_SCOPE = 'https://api.ebay.com/oauth/api_scope/sell.inventory';
export const ebaySettings = z.object({
  seller_settings_read: z.preprocess(
    (v) => (v === 'true' ? true : v === 'false' || v === '' ? false : v),
    z.boolean().default(false),
  ),
  fulfillment_write: z.preprocess(
    (v) => (v === 'true' ? true : v === 'false' || v === '' ? false : v),
    z.boolean().default(false),
  ),
  inventory_access: z
    .enum(['orders', 'orders_inventory', 'orders_inventory_write'])
    .default('orders'),
  marketplace_id: z
    .string()
    .regex(/^EBAY_[A-Z_]{2,20}$/)
    .default('EBAY_DE'),
  price_mode: z.enum(['gross', 'net']).default('gross'),
});
export const ebayReadScopes = (settings: any) =>
  (settings?.fulfillment_write === true ? EBAY_FULFILLMENT_WRITE_SCOPE : EBAY_READ_SCOPE) +
  (settings?.inventory_access === 'orders_inventory_write'
    ? ' ' + EBAY_INVENTORY_WRITE_SCOPE
    : settings?.inventory_access === 'orders_inventory'
      ? ' ' + EBAY_INVENTORY_SCOPE
      : '') +
  (settings?.seller_settings_read === true ? ' ' + EBAY_ACCOUNT_READ_SCOPE : '');
export function requireEbayWrite(ch: any) {
  ensure(
    ch.settings.simulation ||
      (ch.settings.inventory_access === 'orders_inventory_write' &&
        (ch.oauth_scopes ?? '').split(' ').includes(EBAY_INVENTORY_WRITE_SCOPE)),
    422,
    'Włącz zapis Inventory eBay i połącz konto z zakresem sell.inventory',
  );
}
export const ebayScopesMatch = (ch: any) =>
  ebayReadScopes(ch.settings)
    .split(' ')
    .every((scope) => (ch.oauth_scopes ?? '').split(' ').includes(scope));
export const ebayBase = (mode: string) =>
  mode === 'sandbox' ? 'https://api.sandbox.ebay.com' : 'https://api.ebay.com';
export function ebayConnectionHash(ch: any) {
  const { access_token: _access, ...credentials } = decrypt(ch.credentials);
  return createHash('sha256')
    .update(
      JSON.stringify({ provider: ch.provider, mode: ch.mode, settings: ch.settings, credentials }),
    )
    .digest('hex');
}
export const ebaySecret = z
  .string()
  .min(1)
  .max(10000)
  .regex(/^[^\s]+$/);
export function ebayCredentials(value: Record<string, string>) {
  return z
    .object({
      client_id: ebaySecret.regex(/^[^:]+$/),
      client_secret: ebaySecret,
      refresh_token: ebaySecret,
    })
    .parse(value);
}
export const ebayRuName = z
  .string()
  .min(1)
  .max(250)
  .regex(/^[A-Za-z0-9_-]+$/);
export function ebayConnectionCredentials(value: Record<string, string>) {
  const parsed = z
    .object({
      client_id: ebaySecret.regex(/^[^:]+$/),
      client_secret: ebaySecret,
      refresh_token: ebaySecret.optional(),
      ru_name: ebayRuName.optional(),
    })
    .parse(
      Object.fromEntries(
        Object.entries(value).filter(
          ([k, v]) => v !== '' || !['refresh_token', 'ru_name'].includes(k),
        ),
      ),
    );
  ensure(
    parsed.refresh_token || parsed.ru_name,
    422,
    'Podaj RuName do OAuth lub istniejący refresh token eBay',
  );
  return Object.fromEntries(Object.entries(parsed).filter(([, v]) => v !== undefined)) as Record<
    string,
    string
  >;
}
export function ebayId(value: unknown) {
  return z
    .string()
    .min(1)
    .max(160)
    .regex(/^[A-Za-z0-9_-]+$/)
    .parse(value);
}
const timestamp = z
  .string()
  .datetime({ precision: 3 })
  .refine((v) => new Date(v).toISOString() === v);
export const ebayWindowSchema = z
  .object({
    from: timestamp,
    to: timestamp,
    offset: z.number().int().min(0).max(999950).multipleOf(50),
  })
  .strict()
  .refine(
    (v) =>
      v.from <= v.to &&
      Date.parse(v.to) <= Date.now() + 5000 &&
      Date.parse(v.from) >= Date.now() - 731 * 86400000,
  );
export type EbayWindow = z.infer<typeof ebayWindowSchema>;
export function initialEbayWindow(previous?: string | null): EbayWindow {
  const to = new Date(Date.now() - 5000).toISOString();
  return {
    from: new Date(
      previous ? Date.parse(timestamp.parse(previous)) - 600000 : Date.parse(to) - 90 * 86400000,
    ).toISOString(),
    to,
    offset: 0,
  };
}
export function ebayCursor(w: EbayWindow) {
  return Buffer.from(JSON.stringify(w)).toString('base64url');
}
export function parseEbayCursor(cursor?: string | null) {
  if (!cursor) return initialEbayWindow();
  ensure(/^[A-Za-z0-9_-]{1,2048}$/.test(cursor), 422, 'Nieprawidłowy cursor eBay');
  let v: unknown;
  try {
    v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new Problem(422, 'Nieprawidłowy cursor eBay');
  }
  return ebayWindowSchema.parse(v);
}
export async function ebayJson(r: Response, limit = 4 * 1024 * 1024) {
  const reader = r.body?.getReader();
  ensure(reader, 502, 'Brak odpowiedzi eBay');
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const p = await reader.read();
      if (p.done) break;
      size += p.value.byteLength;
      ensure(size <= limit, 502, 'Odpowiedź eBay przekracza limit');
      parts.push(p.value);
    }
    return JSON.parse(Buffer.concat(parts).toString('utf8'));
  } catch (e) {
    if (e instanceof Problem) throw e;
    throw new Problem(502, 'Nieprawidłowy JSON eBay');
  } finally {
    await reader.cancel();
  }
}
export async function refreshEbay(
  mode: string,
  credentials: Record<string, string>,
  transport: Transport,
  scope = EBAY_READ_SCOPE,
) {
  ensure(
    [
      EBAY_TRADING_SCOPE,
      ...[EBAY_READ_SCOPE, EBAY_FULFILLMENT_WRITE_SCOPE].flatMap((s) =>
        [s, s + ' ' + EBAY_INVENTORY_SCOPE, s + ' ' + EBAY_INVENTORY_WRITE_SCOPE].flatMap((v) => [
          v,
          v + ' ' + EBAY_ACCOUNT_READ_SCOPE,
        ]),
      ),
    ].includes(scope),
    422,
    'Nieprawidłowy zakres eBay',
  );
  const c = ebayCredentials(credentials);
  const r = await ebayLimitedTransport(
    mode,
    c.client_id,
    transport,
  )(ebayBase(mode) + '/identity/v1/oauth2/token', {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(12000),
    headers: {
      Authorization: 'Basic ' + Buffer.from(c.client_id + ':' + c.client_secret).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: c.refresh_token,
      scope,
    }).toString(),
  }).catch((e) => {
    if (e instanceof EbayApiWait) throw e;
    throw new Problem(502, 'Brak odpowiedzi OAuth eBay');
  });
  if (!r.ok) {
    await r.body?.cancel();
    throw new Problem(
      r.status === 400 || r.status === 401 ? 401 : 502,
      'OAuth eBay: HTTP ' + r.status + '; sprawdź zgodę użytkownika i środowisko',
    );
  }
  const v = await ebayJson(r, 64 * 1024);
  const parsed = z
    .object({
      access_token: ebaySecret,
      expires_in: z.number().int().min(1).max(86400),
      scope: z.string().max(10000).optional(),
      token_type: z
        .string()
        .refine((v) => v.toLowerCase() === 'user access token' || v.toLowerCase() === 'bearer'),
    })
    .safeParse(v);
  ensure(parsed.success, 502, 'Nieprawidłowa odpowiedź OAuth eBay');
  ensure(
    parsed.data.scope === undefined ||
      scope.split(' ').every((s) => parsed.data.scope!.split(' ').includes(s)),
    401,
    'OAuth eBay nie potwierdził wymaganych zakresów',
  );
  return parsed.data;
}
const stamp = (raw: any) => ({
  ...raw,
  id: ebayId(raw?.orderId),
  _dyna: { field_groups: 'TAX_BREAKDOWN' },
});
export class Ebay {
  private pendingMutation?: { url: string; method: string; permit?: EbayApiPermit };
  constructor(
    public mode: string,
    public credentials: Record<string, string>,
    public transport: Transport,
  ) {
    this.transport = ebayLimitedTransport(mode, credentials.client_id, transport);
  }
  async mutationCheckpoint(
    path: string,
    method: 'POST' | 'PUT',
    checkpoint: () => Promise<boolean>,
  ) {
    ensure(this.credentials.access_token, 401, 'Brak tokena użytkownika eBay');
    ensure(!this.pendingMutation, 409, 'Inny zapis eBay ma już zarezerwowane miejsce API');
    const url = ebayBase(this.mode) + path,
      permit = await reserveEbayTransport(this.transport, url, method);
    try {
      const ready = await checkpoint();
      if (ready) this.pendingMutation = { url, method, permit };
      else if (permit) await releaseEbayApi(permit);
      return ready;
    } catch (e) {
      if (permit) await releaseEbayApi(permit).catch(() => {});
      throw e;
    }
  }
  async releaseMutation() {
    const pending = this.pendingMutation;
    this.pendingMutation = undefined;
    if (pending?.permit) await releaseEbayApi(pending.permit);
  }
  private async mutationTransport(url: string, init: RequestInit) {
    const pending = this.pendingMutation;
    this.pendingMutation = undefined;
    if (!pending) return this.transport(url, init);
    if (pending.url !== url || pending.method !== init.method) {
      if (pending.permit) await releaseEbayApi(pending.permit);
      throw new Problem(409, 'Zapis eBay nie odpowiada zarezerwowanemu miejscu API');
    }
    return sendEbayReserved(this.transport, pending.permit, url, init);
  }
  async request(
    path: string,
    fence?: () => Promise<void>,
    api: 'fulfillment' | 'inventory' | 'account' | 'taxonomy' = 'fulfillment',
    language?: string,
  ) {
    ensure(this.credentials.access_token, 401, 'Połącz konto eBay za pomocą tokena użytkownika');
    ensure(!language || /^[a-z]{2}-[A-Z]{2}$/.test(language), 422, 'Nieprawidłowy język eBay');
    for (let attempt = 0; attempt < 3; attempt++) {
      await fence?.();
      const r = await this.transport(
        ebayBase(this.mode) + (api === 'taxonomy' ? '/commerce/' : '/sell/') + api + '/v1/' + path,
        {
          method: 'GET',
          redirect: 'error',
          signal: AbortSignal.timeout(12000),
          headers: {
            Authorization: 'Bearer ' + this.credentials.access_token,
            Accept: 'application/json',
            ...(language ? { 'Content-Language': language } : {}),
          },
        },
      ).catch((e) => {
        if (e instanceof EbayApiWait) throw e;
        throw new Problem(502, 'Brak odpowiedzi API eBay');
      });
      if ([429, 502, 503, 504].includes(r.status) && attempt < 2) {
        const retry = r.headers.get('retry-after');
        const ms =
          retry && /^\d+(\.\d+)?$/.test(retry)
            ? Number(retry) * 1000
            : retry
              ? Date.parse(retry) - Date.now()
              : 100 * (attempt + 1);
        await r.body?.cancel();
        if (r.status === 429 && ebayHasApiControl(this.transport)) continue;
        await setTimeout(Math.min(5000, Math.max(0, Number.isFinite(ms) ? ms : 200)));
        continue;
      }
      if (!r.ok) {
        await r.body?.cancel();
        throw new Problem(
          [401, 403, 404].includes(r.status) ? r.status : 502,
          'eBay: HTTP ' + r.status + ' podczas odczytu',
        );
      }
      const v = await ebayJson(r);
      ensure(
        v && typeof v === 'object' && !Array.isArray(v) && !v.errors?.length && !v.warnings?.length,
        502,
        'eBay zwrócił błąd lub ostrzeżenie; nie przyjęto niepełnych danych',
      );
      return v;
    }
    throw new Problem(502, 'Wyczerpano ponowienia odczytu eBay');
  }
  /** Mutation is sent once. A durable caller reconciles any uncertain or partial outcome by GET. */
  async updatePriceQuantity(body: unknown, fence?: () => Promise<void>) {
    ensure(this.credentials.access_token, 401, 'Brak tokena użytkownika eBay');
    await fence?.();
    const r = await this.mutationTransport(
      ebayBase(this.mode) + '/sell/inventory/v1/bulk_update_price_quantity',
      {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(12000),
        headers: {
          Authorization: 'Bearer ' + this.credentials.access_token,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
    ).catch((e) => {
      if (e instanceof EbayApiWait) throw e;
      throw new Problem(502, 'Niepewny wynik zapisu eBay; wymagany odczyt');
    });
    if (![200, 207].includes(r.status)) {
      await r.body?.cancel();
      throw new Problem(
        [401, 403].includes(r.status) ? r.status : 502,
        'Zapis eBay: HTTP ' + r.status + '; wymagane uzgodnienie bez powtarzania POST',
      );
    }
    const v = await ebayJson(r);
    ensure(
      r.status === 200 &&
        Array.isArray(v?.responses) &&
        v.responses.length > 0 &&
        !v.errors?.length &&
        !v.warnings?.length &&
        v.responses.every(
          (x: any) => x.statusCode === 200 && !x.errors?.length && !x.warnings?.length,
        ),
      502,
      'Częściowy lub niepewny wynik zapisu eBay; wymagany odczyt',
    );
    return v;
  }
  async createInventory(sku: string, body: unknown, language: string) {
    ensure(
      sku.length > 0 &&
        sku.length <= 50 &&
        !['.', '..'].includes(sku) &&
        !/[\x00-\x1f\x7f]/.test(sku),
      422,
      'Nieprawidłowe SKU eBay',
    );
    return this.inventoryCreation(
      'PUT',
      'inventory_item/' + encodeURIComponent(sku),
      body,
      language,
    );
  }
  async createOffer(body: unknown, language: string) {
    const v = await this.inventoryCreation('POST', 'offer', body, language);
    ensure(
      v && typeof v.offerId === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(v.offerId),
      502,
      'eBay nie potwierdziło ID szkicu; wymagany odczyt',
    );
    return v as { offerId: string };
  }
  private async inventoryCreation(
    method: 'PUT' | 'POST',
    path: string,
    body: unknown,
    language: string,
  ) {
    ensure(this.credentials.access_token, 401, 'Brak tokena użytkownika eBay');
    ensure(/^[a-z]{2}-[A-Z]{2}$/.test(language), 422, 'Nieprawidłowy język eBay');
    const r = await this.mutationTransport(ebayBase(this.mode) + '/sell/inventory/v1/' + path, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(12000),
      headers: {
        Authorization: 'Bearer ' + this.credentials.access_token,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'Content-Language': language,
      },
      body: JSON.stringify(body),
    }).catch((e) => {
      if (e instanceof EbayApiWait) throw e;
      throw new Problem(502, 'Niepewny wynik tworzenia eBay; uzgodnij odczytem');
    });
    if (!(method === 'PUT' ? [200, 201, 204] : [201]).includes(r.status)) {
      await r.body?.cancel();
      throw new Problem(
        [401, 403].includes(r.status) ? r.status : 502,
        'Tworzenie eBay: HTTP ' + r.status + '; wymagany odczyt bez powtarzania zapisu',
      );
    }
    if (r.status === 204) {
      await r.body?.cancel();
      return null;
    }
    const v = await ebayJson(r);
    ensure(
      v && typeof v === 'object' && !Array.isArray(v) && !v.errors?.length && !v.warnings?.length,
      502,
      'Niepewny wynik tworzenia eBay; wymagany odczyt',
    );
    return v;
  }
  /** Publish once; recovery must read the existing offer, never replay this POST. */
  async publishOffer(offerId: string) {
    ensure(/^[A-Za-z0-9_-]{1,160}$/.test(offerId), 422, 'Nieprawidłowe ID oferty eBay');
    ensure(this.credentials.access_token, 401, 'Brak tokena użytkownika eBay');
    const r = await this.mutationTransport(
      ebayBase(this.mode) + '/sell/inventory/v1/offer/' + encodeURIComponent(offerId) + '/publish',
      {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(12000),
        headers: {
          Authorization: 'Bearer ' + this.credentials.access_token,
          Accept: 'application/json',
        },
      },
    ).catch((e) => {
      if (e instanceof EbayApiWait) throw e;
      throw new Problem(502, 'Niepewny wynik publikacji eBay; wymagany odczyt');
    });
    if (r.status !== 200) {
      await r.body?.cancel();
      throw new Problem(
        [401, 403].includes(r.status) ? r.status : 502,
        'Publikacja eBay: HTTP ' + r.status + '; uzgodnij bez powtarzania POST',
      );
    }
    const v = await ebayJson(r);
    ensure(
      v &&
        /^[A-Za-z0-9_-]{1,160}$/.test(v.listingId ?? '') &&
        !v.errors?.length &&
        !v.warnings?.length,
      502,
      'eBay nie potwierdziło publikacji; wymagany odczyt',
    );
    return v as { listingId: string };
  }
  async orders(cursor?: string | null, window?: EbayWindow, fence?: () => Promise<void>) {
    const w = window ? ebayWindowSchema.parse(window) : parseEbayCursor(cursor);
    const filter = `lastmodifieddate:[${w.from}..${w.to}]`;
    const params = new URLSearchParams({
      filter,
      limit: '50',
      offset: String(w.offset),
      fieldGroups: 'TAX_BREAKDOWN',
    });
    const raw = await this.request('order?' + params, fence);
    ensure(
      Number.isSafeInteger(raw.total) &&
        raw.total >= 0 &&
        raw.total <= 1000000 &&
        raw.offset === w.offset &&
        raw.limit === 50,
      502,
      'Nieprawidłowe metadane strony eBay',
    );
    const rows = raw.orders ?? (raw.total === 0 ? [] : undefined);
    ensure(
      Array.isArray(rows) && rows.length <= 50 && w.offset + rows.length <= raw.total,
      502,
      'Nieprawidłowa strona eBay',
    );
    ensure(
      rows.every((o: any) => {
        const date = Date.parse(o?.lastModifiedDate);
        return Number.isFinite(date) && date >= Date.parse(w.from) && date <= Date.parse(w.to);
      }),
      502,
      'Zamówienie eBay poza zakresem odczytu',
    );
    const data = rows.map(stamp);
    ensure(new Set(data.map((o) => o.id)).size === data.length, 502, 'Powtórzone zamówienia eBay');
    const more = w.offset + data.length < raw.total;
    ensure(!more || (data.length === 50 && w.offset < 999950), 502, 'Brak postępu strony eBay');
    ensure(Boolean(raw.next) === more, 502, 'Niespójna paginacja eBay');
    if (more) {
      let next: URL;
      try {
        next = new URL(raw.next);
      } catch {
        throw new Problem(502, 'Nieprawidłowa następna strona eBay');
      }
      ensure(
        next.origin === ebayBase(this.mode) &&
          next.pathname === '/sell/fulfillment/v1/order' &&
          !next.username &&
          !next.password &&
          !next.hash &&
          next.searchParams.get('offset') === String(w.offset + 50) &&
          next.searchParams.get('limit') === '50' &&
          next.searchParams.get('filter') === filter &&
          next.searchParams.get('fieldGroups') === 'TAX_BREAKDOWN',
        502,
        'Nieprawidłowa następna strona eBay',
      );
    }
    const nextWindow = { ...w, offset: w.offset + (more ? 50 : 0) };
    return {
      data,
      has_more: more,
      next_cursor: more ? ebayCursor(nextWindow) : null,
      window: nextWindow,
    };
  }
  async order(id: string, fence?: () => Promise<void>) {
    const v = await this.request(
      'order/' + encodeURIComponent(ebayId(id)) + '?fieldGroups=TAX_BREAKDOWN',
      fence,
    );
    ensure(v.orderId === id, 502, 'eBay zwrócił inne zamówienie');
    return stamp(v);
  }
  async shippingFulfillments(id: string, fence?: () => Promise<void>) {
    return this.request(`order/${encodeURIComponent(ebayId(id))}/shipping_fulfillment`, fence);
  }
  /** One POST only; caller must persist write_started and reconcile by GET. */
  async createShippingFulfillment(id: string, payload: unknown, fence?: () => Promise<void>) {
    ensure(this.credentials.access_token, 401, 'Brak tokena użytkownika eBay');
    await fence?.();
    const path = `/sell/fulfillment/v1/order/${encodeURIComponent(ebayId(id))}/shipping_fulfillment`;
    const r = await this.mutationTransport(ebayBase(this.mode) + path, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(12000),
      headers: {
        Authorization: 'Bearer ' + this.credentials.access_token,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(payload),
    }).catch((e) => {
      if (e instanceof EbayApiWait) throw e;
      throw new Problem(502, 'Niepewny wynik zgłoszenia wysyłki eBay; odczytaj wynik');
    });
    await r.body?.cancel();
    ensure(
      r.status === 201,
      r.status === 401 ? 401 : 502,
      'Zgłoszenie wysyłki eBay: HTTP ' + r.status + '; odczytaj wynik bez powtarzania POST',
    );
    let location: URL;
    try {
      location = new URL(r.headers.get('location') ?? '');
    } catch {
      throw new Problem(502, 'Brak poprawnego Location eBay; odczytaj wynik');
    }
    ensure(
      location.origin === ebayBase(this.mode) &&
        !location.search &&
        !location.hash &&
        !location.username &&
        !location.password &&
        location.pathname.startsWith(path + '/'),
      502,
      'Nieprawidłowy Location eBay; odczytaj wynik',
    );
    const remoteId = location.pathname.slice(path.length + 1);
    ensure(
      /^[A-Za-z0-9_-]{1,160}$/.test(remoteId),
      502,
      'Nieprawidłowy ID realizacji eBay; odczytaj wynik',
    );
    return remoteId;
  }
  async test() {
    await this.orders();
    return { scope: 'orders_read' };
  }
}
// Preserve provider totals; line.total already includes delivery and taxes. No FX or inferred VAT.
export function normalizeEbay(raw: any, sourceLines = false) {
  ensure(
    raw._dyna?.field_groups === 'TAX_BREAKDOWN' && raw.id === raw.orderId,
    422,
    'Wymagany odczyt eBay z TAX_BREAKDOWN i zgodnym ID',
  );
  const currency = raw.pricingSummary?.total?.currency;
  const money = (a: any, signed = false) => {
    ensure(
      a &&
        a.currency === currency &&
        typeof a.value === 'string' &&
        (signed ? /^-?\d+(\.\d{1,2})?$/ : /^\d+(\.\d{1,2})?$/).test(a.value),
      422,
      'Niezgodna waluta lub kwota eBay',
    );
    const [whole, frac = ''] = a.value.replace(/^-/, '').split('.');
    const v =
      (Number(whole) * 100 + Number(frac.padEnd(2, '0'))) * (a.value.startsWith('-') ? -1 : 1);
    ensure(
      Number.isSafeInteger(v) && Math.abs(v) <= 2147483647,
      422,
      'Kwota eBay przekracza limit',
    );
    return v;
  };
  const optional = (a: any, signed = false) => (a == null ? 0 : money(a, signed));
  const total = money(raw.pricingSummary?.total),
    blockers: string[] = [];
  const instructions = raw.fulfillmentStartInstructions;
  ensure(
    Array.isArray(instructions) && instructions.length === 1,
    422,
    'Wymagana jedna kompletna instrukcja dostawy eBay',
  );
  const instruction = instructions[0],
    ship = instruction.shippingStep?.shipTo,
    address = ship?.contactAddress;
  if (
    instruction.fulfillmentInstructionsType !== 'SHIP_TO' ||
    instruction.ebaySupportedFulfillment ||
    raw.program ||
    instruction.shippingStep?.shipToReferenceId
  )
    blockers.push('Program eBay, odbiór lub dostawa specjalna wymaga osobnej realizacji');
  ensure(
    address?.addressLine1 && address?.city && address?.postalCode && ship?.fullName,
    422,
    'Brak pełnego adresu dostawy eBay',
  );
  ensure(
    ship?.email || raw.buyer?.buyerRegistrationAddress?.email,
    422,
    'Brak adresu email kupującego; eBay ogranicza jego dostępność dla starszych zamówień',
  );
  if (
    raw.cancelStatus?.cancelState !== 'NONE_REQUESTED' ||
    raw.cancelStatus?.cancelledDate ||
    raw.cancelStatus?.cancelRequests?.length
  )
    blockers.push('Anulowanie lub prośba o anulowanie wymaga uzgodnienia');
  if (raw.orderFulfillmentStatus !== 'NOT_STARTED' || raw.fulfillmentHrefs?.length)
    blockers.push('Zamówienie już realizowane w eBay wymaga uzgodnienia');
  ensure(
    Array.isArray(raw.lineItems) && raw.lineItems.length > 0 && raw.lineItems.length <= 100,
    422,
    'Nieprawidłowe pozycje eBay',
  );
  let shipping = 0;
  const ids = new Set();
  const items = raw.lineItems.map((i: any) => {
    ensure(i.lineItemId && !ids.has(i.lineItemId), 422, 'Powtórzona pozycja eBay');
    ids.add(i.lineItemId);
    if (
      i.lineItemFulfillmentStatus !== 'NOT_STARTED' ||
      i.refunds?.length ||
      i.linkedOrderLineItems?.length ||
      i.giftDetails
    )
      blockers.push('Realizacja, zwrot lub specjalna pozycja eBay wymaga uzgodnienia');
    ensure(
      typeof i.sku === 'string' &&
        i.sku.length > 0 &&
        i.sku.length <= 160 &&
        !/[\x00-\x1f]/.test(i.sku),
      422,
      'Brak unikalnego SKU eBay; uzupełnij SKU oferty u dostawcy',
    );
    const delivery = i.deliveryCost;
    const cost =
      money(delivery?.shippingCost) +
      optional(delivery?.handlingCost) -
      Math.abs(optional(delivery?.discountAmount, true));
    ensure(cost >= 0, 422, 'Ujemna dostawa eBay');
    shipping += cost;
    if (
      optional(delivery?.importCharges) ||
      optional(delivery?.shippingIntermediationFee) ||
      (i.ebayCollectedCharges && Object.keys(i.ebayCollectedCharges).length)
    )
      blockers.push('Opłaty importowe lub dodatkowe eBay wymagają osobnego rozliczenia');
    ensure(Array.isArray(i.taxes), 422, 'Brak kompletnego podziału podatków eBay');
    for (const tax of [...i.taxes, ...(i.ebayCollectAndRemitTaxes ?? [])]) money(tax.amount);
    const lineTotal = money(i.total) - cost;
    ensure(lineTotal >= 0, 422, 'Dostawa przekracza kwotę pozycji eBay');
    return {
      ...(sourceLines ? { remote_line_id: i.lineItemId } : {}),
      external_id: i.sku,
      sku: i.sku,
      name: i.title,
      quantity: i.quantity,
      line_total: lineTotal,
    };
  });
  const pricing = raw.pricingSummary;
  ensure(
    shipping === money(pricing.deliveryCost) + optional(pricing.deliveryDiscount, true),
    422,
    'Suma kosztów dostawy eBay nie jest zgodna',
  );
  if (optional(pricing.fee) || optional(pricing.adjustment, true))
    blockers.push('Opłaty lub korekta zamówienia eBay wymagają uzgodnienia');
  ensure(
    Array.isArray(raw.paymentSummary?.payments) && Array.isArray(raw.paymentSummary?.refunds),
    422,
    'Brak pełnego zestawienia płatności eBay',
  );
  if (raw.paymentSummary.refunds.length) blockers.push('Zwrot płatności eBay wymaga uzgodnienia');
  const paid = raw.orderPaymentStatus === 'PAID';
  if (!['PAID', 'PENDING', 'FAILED'].includes(raw.orderPaymentStatus))
    blockers.push('Status płatności eBay wymaga uzgodnienia');
  const payments = raw.paymentSummary.payments;
  if (
    paid &&
    (!payments.length ||
      payments.some((p: any) => p.paymentStatus !== 'PAID') ||
      payments.reduce((s: number, p: any) => s + money(p.amount), 0) !== total)
  )
    blockers.push('Zakończone płatności eBay nie pokrywają kwoty kupującego');
  if (!paid && payments.some((p: any) => p.paymentStatus === 'PAID'))
    blockers.push('Częściowa wpłata eBay wymaga uzgodnienia');
  return {
    external_id: ebayId(raw.orderId),
    currency,
    customer_name: ship.fullName,
    email: ship.email || raw.buyer.buyerRegistrationAddress.email,
    address: {
      street: [address.addressLine1, address.addressLine2, address.stateOrProvince]
        .filter(Boolean)
        .join(', '),
      city: address.city,
      postal_code: address.postalCode,
      country: address.countryCode,
      phone: ship.primaryPhone?.phoneNumber ?? '',
    },
    shipping_cost: shipping,
    total,
    paid,
    paid_amount: paid ? total : 0,
    payment_mode: 'prepaid',
    source_status: raw.orderPaymentStatus + '/' + raw.orderFulfillmentStatus,
    note: raw.buyerCheckoutNotes ?? '',
    items,
    blockers,
  };
}
