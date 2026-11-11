import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Transport } from './integrations';
import { ensure, Problem } from './errors';
import type { AmazonMutationTransport } from './amazon-api-limits';

export const AMAZON_VERSION = '2026-01-01';
export const AMAZON_DATA = 'BUYER,RECIPIENT,PROCEEDS,FULFILLMENT,CANCELLATION,TAX,PAYMENT,PACKAGES';
export const AMAZON_MARKETS: Record<string, string> = {
  A1C3SOZRARQ6R3: 'eu',
  A1PA6795UKMFR9: 'eu',
  A1F83G8C2ARO7P: 'eu',
  A13V1IB3VIYZZH: 'eu',
  APJ6JRA9NG5V4: 'eu',
  A1RKKUPIHCS9HS: 'eu',
  AMEN7PMS3EDWL: 'eu',
  A1805IZSGTT6HS: 'eu',
  A28R8C7NBKEWEA: 'eu',
  A2NODRKZP88ZB9: 'eu',
  AE08WJ6YKNBMC: 'eu',
  ARBP9OOSHTCHU: 'eu',
  A33AVAJ2PDY3EV: 'eu',
  A17E79C6D8DWNP: 'eu',
  A2VIGQ35RCS4UG: 'eu',
  A21TJRUUN4KGV: 'eu',
  ATVPDKIKX0DER: 'na',
  A2EUQ1WTGCTBG2: 'na',
  A1AM78C64UM0Y8: 'na',
  A2Q3Y263D00KWC: 'na',
  A19VAU5U5O7RUS: 'fe',
  A39IBJ37TRP1C6: 'fe',
  A1VC38T7YXB528: 'fe',
};
export const amazonSettings = z
  .object({
    shipment_write: z
      .preprocess((v) => (v === 'true' ? true : v === 'false' ? false : v), z.boolean())
      .default(false),
    listing_write: z
      .preprocess((v) => (v === 'true' ? true : v === 'false' ? false : v), z.boolean())
      .default(false),
    application_id: z
      .string()
      .trim()
      .regex(/^amzn1\.sellerapps\.app\.[A-Za-z0-9-]{1,100}$/)
      .or(z.literal(''))
      .default(''),
    oauth_redirect_uri: z.string().url().default('http://127.0.0.1:4100/api/oauth/amazon/callback'),
    oauth_beta: z
      .preprocess((v) => (v === 'true' ? true : v === 'false' ? false : v), z.boolean())
      .default(true),
    region: z.enum(['eu', 'na', 'fe']).default('eu'),
    marketplace_id: z.string().trim().default('A1C3SOZRARQ6R3'),
    selling_partner_id: z
      .string()
      .trim()
      .regex(/^[A-Z0-9]{1,32}$/)
      .or(z.literal(''))
      .default(''),
  })
  .refine(
    (s) => AMAZON_MARKETS[s.marketplace_id] === s.region,
    'Marketplace Amazon nie pasuje do regionu',
  );
const secret = z
  .string()
  .min(1)
  .max(2048)
  .regex(/^[^\s\x00-\x1f\x7f]+$/);
export const amazonConnectionCredentials = z.object({
  client_id: secret,
  client_secret: secret,
  refresh_token: secret.or(z.literal('')).default(''),
});
export const amazonCredentials = amazonConnectionCredentials.extend({ refresh_token: secret });
export const amazonBase = (mode: string, region: string) => {
  ensure(
    ['live', 'sandbox'].includes(mode) && ['eu', 'na', 'fe'].includes(region),
    422,
    'Nieprawidłowe środowisko Amazon',
  );
  return `https://${mode === 'sandbox' ? 'sandbox.' : ''}sellingpartnerapi-${region}.amazon.com`;
};
const iso = z.iso.datetime({ offset: true });
export const amazonWindow = z
  .object({
    from: iso,
    to: iso,
    token: z.string().min(1).max(16000).nullable().default(null),
    started_at: iso,
    connection_hash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    seen: z
      .array(z.string().regex(/^[a-f0-9]{64}$/))
      .max(256)
      .default([]),
  })
  .refine((w) => Date.parse(w.from) < Date.parse(w.to), 'Nieprawidłowe okno Amazon');
export type AmazonWindow = z.infer<typeof amazonWindow>;
export function initialAmazonWindow(watermark?: string | null): AmazonWindow {
  const now = Date.now();
  return {
    from: new Date(
      watermark
        ? Math.max(now - 2 * 365 * 86400000, Date.parse(watermark) - 600000)
        : now - 90 * 86400000,
    ).toISOString(),
    to: new Date(now - 120000).toISOString(),
    token: null,
    started_at: new Date(now).toISOString(),
    seen: [],
  };
}
export const amazonOrderId = (v: unknown) =>
  z
    .string()
    .regex(/^\d{3}-\d{7}-\d{7}$/)
    .parse(v);
export const amazonEnvelope = (raw: any) => ({ ...raw, id: amazonOrderId(raw?.orderId) });
export const amazonShipmentBody = z
  .object({
    marketplaceId: z.string().min(1).max(32),
    codCollectionMethod: z.literal('DirectPayment').optional(),
    packageDetail: z
      .object({
        packageReferenceId: z.string().regex(/^[1-9]\d{0,17}$/),
        carrierCode: z
          .string()
          .trim()
          .regex(/^[A-Za-z0-9_-]{1,64}$/),
        carrierName: z
          .string()
          .trim()
          .min(1)
          .max(100)
          .regex(/^[^\x00-\x1f\x7f]+$/)
          .optional(),
        shippingMethod: z
          .string()
          .trim()
          .min(1)
          .max(100)
          .regex(/^[^\x00-\x1f\x7f]+$/)
          .optional(),
        trackingNumber: z.string().regex(/^[A-Za-z0-9-]{1,100}$/),
        shipDate: iso,
        orderItems: z
          .array(
            z
              .object({
                orderItemId: z.string().regex(/^[A-Za-z0-9_-]{1,160}$/),
                quantity: z.number().int().min(1).max(1000000),
              })
              .strict(),
          )
          .min(1)
          .max(100),
      })
      .strict(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.packageDetail.carrierCode === 'Other' && !v.packageDetail.carrierName)
      ctx.addIssue({ code: 'custom', message: 'Dla Other wymagana nazwa przewoźnika' });
    if (
      new Set(v.packageDetail.orderItems.map((i) => i.orderItemId)).size !==
      v.packageDetail.orderItems.length
    )
      ctx.addIssue({ code: 'custom', message: 'Powtórzone ID pozycji Amazon' });
    if (v.codCollectionMethod && v.marketplaceId !== 'A1VC38T7YXB528')
      ctx.addIssue({ code: 'custom', message: 'codCollectionMethod dotyczy wyłącznie Japonii' });
  });

// Token is kept only in the short-lived connector instance. Long-lived grant remains encrypted in channels.
export class Amazon {
  private access?: { token: string; until: number };
  readonly settings: z.infer<typeof amazonSettings>;
  readonly credentials: z.infer<typeof amazonCredentials>;
  constructor(
    readonly mode: string,
    settings: Record<string, unknown>,
    credentials: Record<string, string>,
    private transport: Transport,
    readonly documentTransport: Transport = transport,
  ) {
    this.settings = amazonSettings.parse(settings);
    this.credentials = amazonCredentials.parse(credentials);
  }
  async token(fence?: () => Promise<void>) {
    if (this.access && this.access.until > Date.now() + 60000) return this.access.token;
    await fence?.();
    const r = await this.transport('https://api.amazon.com/auth/o2/token', {
      method: 'POST',
      redirect: 'error',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        Accept: 'application/json',
      },
      body: new URLSearchParams({ grant_type: 'refresh_token', ...this.credentials }).toString(),
    });
    ensure(
      r.ok,
      r.status === 401 || r.status === 400 ? 401 : 502,
      `OAuth Amazon: HTTP ${r.status}`,
    );
    const p = z
      .object({
        access_token: secret,
        token_type: z
          .string()
          .transform((v) => v.toLowerCase())
          .pipe(z.literal('bearer')),
        expires_in: z.number().int().min(61).max(86400),
      })
      .safeParse(await r.json().catch(() => null));
    ensure(p.success, 502, 'Nieprawidłowa odpowiedź OAuth Amazon');
    this.access = { token: p.data.access_token, until: Date.now() + p.data.expires_in * 1000 };
    return this.access.token;
  }
  private async request(path: string, query: Record<string, string>, fence?: () => Promise<void>) {
    return this.read(
      `/orders/${AMAZON_VERSION}/orders` + path,
      { includedData: AMAZON_DATA, ...query },
      fence,
    );
  }
  async read(
    path: string,
    query: Record<string, string>,
    fence?: () => Promise<void>,
    requestBody?: Record<string, unknown>,
  ) {
    ensure(
      /^\/(orders\/2026-01-01\/orders|reports\/2021-06-30\/(reports|documents)|listings\/2021-08-01\/items|sellers\/v1\/marketplaceParticipations)(\/[^?#]*)?$/.test(
        path,
      ),
      422,
      'Nieprawidłowy zasób Amazon',
    );
    const u = new URL(amazonBase(this.mode, this.settings.region) + path);
    for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
    for (let retry = 0; retry < 2; retry++) {
      const token = await this.token(fence);
      await fence?.();
      const r = await this.transport(u.toString(), {
        method: requestBody ? 'POST' : 'GET',
        redirect: 'error',
        headers: {
          Accept: 'application/json',
          'x-amz-access-token': token,
          'x-amz-date': new Date().toISOString().replace(/[-:]|\.\d{3}/g, ''),
          'User-Agent': 'DYNAMINDS-Ecommerce/1.0 (Language=TypeScript)',
          ...(requestBody ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(requestBody ? { body: JSON.stringify(requestBody) } : {}),
      });
      if (r.status === 401 && retry === 0) {
        this.access = undefined;
        continue;
      }
      ensure(
        r.ok,
        r.status === 401 ? 401 : r.status === 403 ? 403 : r.status === 429 ? 429 : 502,
        `Amazon API: HTTP ${r.status}`,
      );
      const body = await r.json().catch(() => null);
      ensure(
        body && typeof body === 'object' && !Array.isArray(body),
        502,
        'Nieprawidłowa odpowiedź Amazon Orders',
      );
      return body;
    }
    throw new Problem(401, 'Amazon odrzucił odświeżony token');
  }
  // A mutation is sent once. Token refresh is completed before its durable write checkpoint.
  async patchListing(sku: string, body: Record<string, unknown>, fence: () => Promise<void>) {
    ensure(
      this.access && this.access.until > Date.now() + 60000,
      409,
      'Token Amazon wymaga odświeżenia przed zapisem',
    );
    await fence();
    const u = new URL(
      amazonBase(this.mode, this.settings.region) +
        `/listings/2021-08-01/items/${this.settings.selling_partner_id}/${encodeURIComponent(sku)}`,
    );
    u.searchParams.set('marketplaceIds', this.settings.marketplace_id);
    u.searchParams.set('includedData', 'issues');
    const r = await this.transport(u.toString(), {
      method: 'PATCH',
      redirect: 'error',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'x-amz-access-token': this.access.token,
        'x-amz-date': new Date().toISOString().replace(/[-:]|\.\d{3}/g, ''),
        'User-Agent': 'DYNAMINDS-Ecommerce/1.0 (Language=TypeScript)',
      },
      body: JSON.stringify(body),
    });
    ensure(
      r.ok,
      r.status === 401 ? 401 : r.status === 403 ? 403 : r.status === 400 ? 422 : 502,
      `Amazon PATCH: HTTP ${r.status}`,
    );
    return r.json();
  }
  async orders(
    cursor?: string,
    window?: AmazonWindow,
    fence?: () => Promise<void>,
    connectionHash?: string,
  ) {
    let w: AmazonWindow;
    try {
      w = amazonWindow.parse(
        cursor
          ? JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
          : (window ?? initialAmazonWindow()),
      );
    } catch {
      throw new Problem(422, 'Nieprawidłowy checkpoint Amazon');
    }
    ensure(
      Date.parse(w.to) <= Date.now() - 120000,
      422,
      'Okno Amazon musi kończyć się co najmniej dwie minuty temu',
    );
    ensure(
      !w.token || Date.now() - Date.parse(w.started_at) < 24 * 3600000,
      409,
      'Token strony Amazon wygasł; rozpocznij ponownie ten odczyt',
    );
    ensure(
      !connectionHash ||
        (!cursor && !w.token && !w.connection_hash) ||
        w.connection_hash === connectionHash,
      409,
      'Checkpoint pochodzi z innego połączenia Amazon',
    );
    w = { ...w, ...(connectionHash ? { connection_hash: connectionHash } : {}) };
    const body = await this.request(
      '',
      {
        marketplaceIds: this.settings.marketplace_id,
        lastUpdatedAfter: w.from,
        lastUpdatedBefore: w.to,
        maxResultsPerPage: '50',
        ...(w.token ? { paginationToken: w.token } : {}),
      },
      fence,
    );
    ensure(
      Array.isArray(body.orders) && body.orders.length <= 50,
      502,
      'Nieprawidłowa strona zamówień Amazon',
    );
    const data = body.orders.map(amazonEnvelope),
      ids = data.map((o: any) => o.id);
    ensure(new Set(ids).size === ids.length, 502, 'Powtórzone ID zamówień Amazon na stronie');
    for (const o of data)
      ensure(
        o.salesChannel?.marketplaceId === this.settings.marketplace_id,
        502,
        'Amazon zwrócił zamówienie innego marketplace',
      );
    const next = body.pagination?.nextToken ?? null;
    ensure(
      next === null ||
        (typeof next === 'string' &&
          next.length > 0 &&
          next.length <= 16000 &&
          !w.seen.includes(createHash('sha256').update(next).digest('hex')) &&
          next !== w.token),
      502,
      'Powtórzony lub nieprawidłowy token strony Amazon',
    );
    ensure(!next || data.length > 0, 502, 'Pusta strona Amazon z kontynuacją');
    const nextWindow = {
      ...w,
      token: next,
      seen: next
        ? [...w.seen.slice(-255), createHash('sha256').update(next).digest('hex')]
        : w.seen,
    };
    return {
      data,
      has_more: !!next,
      window: nextWindow,
      next_cursor: next ? Buffer.from(JSON.stringify(nextWindow)).toString('base64url') : null,
    };
  }
  async order(id: string, fence?: () => Promise<void>) {
    const raw = await this.request('/' + encodeURIComponent(amazonOrderId(id)), {}, fence),
      o = amazonEnvelope(raw);
    ensure(
      o.id === id && o.salesChannel?.marketplaceId === this.settings.marketplace_id,
      502,
      'Amazon zwrócił inne zamówienie lub marketplace',
    );
    return o;
  }
  async confirmShipment(
    id: string,
    input: unknown,
    beginWrite: () => Promise<void>,
    fence: () => Promise<void>,
  ) {
    amazonOrderId(id);
    const body = amazonShipmentBody.parse(input);
    ensure(
      this.settings.shipment_write && this.settings.selling_partner_id,
      403,
      'Włącz przekazywanie wysyłek Amazon i uzupełnij sprzedawcę',
    );
    ensure(
      body.marketplaceId === this.settings.marketplace_id,
      422,
      'Marketplace wysyłki nie pasuje do konta',
    );
    ensure(
      Date.parse(body.packageDetail.shipDate) <= Date.now() + 60000,
      422,
      'Wysyłka nie może mieć przyszłej daty',
    );
    const token = await this.token(fence);
    const beforeSend = async () => {
      ensure(
        this.access && this.access.until > Date.now() + 60000,
        409,
        'Token wymaga odświeżenia przed zapisem',
      );
      await beginWrite();
      await fence();
    };
    const url =
      amazonBase(this.mode, this.settings.region) + `/orders/v0/orders/${id}/shipmentConfirmation`;
    const init: RequestInit = {
      method: 'POST',
      redirect: 'error',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'x-amz-access-token': token,
        'x-amz-date': new Date().toISOString().replace(/[-:]|\.\d{3}/g, ''),
        'User-Agent': 'DYNAMINDS-Ecommerce/1.0 (Language=TypeScript)',
      },
      body: JSON.stringify(body),
    };
    const transport = this.transport as AmazonMutationTransport;
    const r = transport.mutation
      ? await transport.mutation(url, init, beforeSend)
      : (await beforeSend(), await transport(url, init));
    // 204 acknowledges receipt only. A durable job must verify PACKAGES before reporting success.
    ensure(
      r.status === 204,
      r.status === 401 ? 401 : r.status === 403 ? 403 : r.status === 400 ? 422 : 502,
      `Amazon confirmShipment: HTTP ${r.status}`,
    );
    return body.packageDetail.packageReferenceId;
  }
  test() {
    return this.orders();
  }
}

const signedCents = (v: unknown) => {
  ensure(
    typeof v === 'string' && /^-?\d+(\.\d{1,2})?$/.test(v),
    422,
    'Kwota Amazon wymaga maksymalnie dwóch miejsc po przecinku',
  );
  const [a, b = ''] = v.replace(/^-/, '').split('.'),
    n = (Number(a) * 100 + Number(b.padEnd(2, '0'))) * (v.startsWith('-') ? -1 : 1);
  ensure(
    Number.isSafeInteger(n) && Math.abs(n) <= 2147483647,
    422,
    'Kwota Amazon przekracza limit',
  );
  return n;
};
export function normalizeAmazon(raw: any, settings: Record<string, unknown>, sourceLines = false) {
  const config = amazonSettings.parse(settings),
    blockers: string[] = [];
  ensure(amazonOrderId(raw.orderId) === raw.id, 422, 'Niezgodne ID Amazon');
  ensure(
    raw.salesChannel?.marketplaceId === config.marketplace_id,
    422,
    'Marketplace Amazon nie pasuje do połączenia',
  );
  const currency = raw.proceeds?.grandTotal?.currencyCode;
  const money = (m: any) => {
    ensure(m?.currencyCode === currency, 422, 'Niezgodna waluta Amazon');
    return signedCents(m.amount);
  };
  const total = money(raw.proceeds?.grandTotal);
  ensure(total > 0, 422, 'Amazon nie udostępnił dodatniej kwoty zamówienia');
  if (raw.fulfillment?.fulfilledBy !== 'MERCHANT')
    blockers.push('FBA wymaga procesu magazynu Amazon; lokalna rezerwacja FBM jest niedozwolona');
  if (raw.fulfillment?.fulfillmentStatus !== 'UNSHIPPED')
    blockers.push('Status Amazon nie jest UNSHIPPED; wymagane uzgodnienie realizacji');
  if (raw.programs?.some((p: string) => !['PRIME', 'PREMIUM'].includes(p)))
    blockers.push('Program specjalny Amazon wymaga osobnego procesu');
  if (raw.associatedOrders?.length)
    blockers.push('Wymiana albo powiązane zamówienie Amazon wymaga uzgodnienia');
  if (raw.packages?.length)
    blockers.push('Zamówienie Amazon zawiera już paczki; wymagane uzgodnienie wysyłki');
  const executions = raw.payment?.paymentExecutions ?? [];
  ensure(Array.isArray(executions), 422, 'Nieprawidłowe płatności Amazon');
  const cod = executions.some((p: any) => p.paymentMethod === 'CashOnDelivery');
  if (cod && executions.some((p: any) => p.paymentMethod !== 'CashOnDelivery'))
    blockers.push('Mieszana płatność z pobraniem wymaga uzgodnienia');
  for (const p of executions) if (p.paymentAmount) money(p.paymentAmount);
  let shipping = 0;
  ensure(
    Array.isArray(raw.orderItems) && raw.orderItems.length > 0 && raw.orderItems.length <= 100,
    422,
    'Brak pozycji Amazon albo przekroczono limit',
  );
  const itemIds = new Set<string>();
  const items = raw.orderItems.map((i: any) => {
    ensure(
      typeof i.orderItemId === 'string' && !itemIds.has(i.orderItemId),
      422,
      'Powtórzone ID pozycji Amazon',
    );
    itemIds.add(i.orderItemId);
    ensure(
      typeof i.product?.sellerSku === 'string' && i.product.sellerSku.length > 0,
      422,
      'Brak SKU sprzedawcy Amazon',
    );
    if (i.cancellation?.cancellationRequest || i.cancellation?.cancellationExecution)
      blockers.push('Pozycja Amazon ma anulowanie albo żądanie anulowania');
    if (
      i.fulfillment?.quantityFulfilled > 0 ||
      (i.fulfillment?.quantityUnfulfilled !== undefined &&
        i.fulfillment.quantityUnfulfilled !== i.quantityOrdered)
    )
      blockers.push('Częściowa realizacja pozycji Amazon wymaga uzgodnienia');
    if (
      i.product.customization ||
      i.measurement ||
      i.fulfillment?.packing?.giftOption ||
      i.associatedOrderItems?.length ||
      i.programs?.length
    )
      blockers.push(
        'Personalizacja, prezent, pomiar albo program pozycji Amazon wymaga osobnego procesu',
      );
    if (i.tax?.taxCollections?.some((t: any) => t.model === 'MARKETPLACE_FACILITATOR'))
      blockers.push('Podatek pobierany przez Amazon wymaga osobnego rozliczenia');
    let item = 0,
      ship = 0;
    ensure(
      Array.isArray(i.proceeds?.breakdowns) && i.proceeds.breakdowns.length > 0,
      422,
      'Brak rozbicia kwot pozycji Amazon',
    );
    for (const b of i.proceeds.breakdowns) {
      const n = money(b.subtotal);
      if (b.type === 'ITEM') item += n;
      else if (b.type === 'SHIPPING') ship += n;
      else if (['TAX', 'DISCOUNT'].includes(b.type)) {
        ensure(
          Array.isArray(b.detailedBreakdowns) && b.detailedBreakdowns.length > 0,
          422,
          'Brak podziału podatku lub rabatu Amazon na towar i dostawę',
        );
        let sum = 0;
        for (const d of b.detailedBreakdowns) {
          const v = money(d.value);
          sum += v;
          ensure(
            ['ITEM', 'SHIPPING'].includes(d.subtype),
            422,
            'Nieobsługiwany składnik podatku lub rabatu Amazon',
          );
          if (d.subtype === 'ITEM') item += v;
          else ship += v;
        }
        ensure(sum === n, 422, 'Niezgodna suma podatku lub rabatu Amazon');
      } else ensure(n === 0, 422, 'Dodatkowa opłata Amazon wymaga osobnej pozycji rozliczenia');
    }
    ensure(
      item >= 0 && ship >= 0 && item + ship === money(i.proceeds.proceedsTotal),
      422,
      'Niezgodne rozbicie kwoty pozycji Amazon',
    );
    shipping += ship;
    return {
      ...(sourceLines ? { remote_line_id: i.orderItemId } : {}),
      external_id: i.product.sellerSku,
      sku: i.product.sellerSku,
      name: i.product.title,
      quantity: i.quantityOrdered,
      line_total: item,
    };
  });
  ensure(
    items.reduce((s: number, i: any) => s + i.line_total, 0) + shipping === total,
    422,
    'Suma pozycji i dostawy Amazon nie zgadza się z zamówieniem',
  );
  const a = raw.recipient?.deliveryAddress;
  ensure(
    a?.name && a.addressLine1 && a.city && a.postalCode && a.countryCode,
    422,
    'Brak danych odbiorcy Amazon; sprawdź zgodę na Direct-to-Consumer Shipping lub dane zamówienia',
  );
  ensure(
    !a.extendedFields && (!a.addressType || ['RESIDENTIAL', 'COMMERCIAL'].includes(a.addressType)),
    422,
    'Adres specjalny Amazon wymaga osobnego procesu dostawy',
  );
  return {
    external_id: raw.id,
    currency,
    customer_name: a.name,
    email: raw.buyer?.buyerEmail ?? '',
    address: {
      street: [a.addressLine1, a.addressLine2, a.addressLine3].filter(Boolean).join(' '),
      city: a.city,
      postal_code: a.postalCode,
      country: a.countryCode,
      phone: a.phone ?? '',
    },
    shipping_cost: shipping,
    total,
    paid: false,
    paid_amount: 0,
    payment_mode: cod ? 'cod' : 'prepaid',
    source_status: raw.fulfillment?.fulfillmentStatus ?? '',
    note: 'Amazon: gotowość do wysyłki nie potwierdza wpłaty. Płatność wymaga osobnego uzgodnienia.',
    items,
    blockers,
  };
}
