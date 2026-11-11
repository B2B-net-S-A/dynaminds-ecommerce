import { z } from 'zod';
import { type Amazon, AMAZON_MARKETS, amazonBase } from './amazon';
import type { Transport } from './integrations';
import { ensure, Problem } from './errors';

// Current public Fulfillment Outbound model, verified 2026-10-05.
// This adapter has no create/update/cancel operation and holds no LWA secrets.
export const AMAZON_MCF_VERSION = '2026-07-04';
export const AMAZON_MCF_ROLE = 'Amazon Fulfillment';
export const AMAZON_MCF_PATH = `/fulfillment/outbound/${AMAZON_MCF_VERSION}`;
const clean = (max: number, empty = false) =>
  z
    .string()
    .min(empty ? 0 : 1)
    .max(max)
    .refine((v) => !/[\x00-\x1f\x7f]/.test(v) && (empty || !!v.trim()));
export const mcfId = clean(40).refine((v) => v !== '.' && v !== '..');
export const mcfSku = clean(50);
const country = z.string().regex(/^[A-Z]{2}$/);
const time = z.iso.datetime({ offset: true });
// Preserve decimal bytes. No floating point, exponent, negative, or implicit FX.
export const mcfDecimal = z.string().regex(/^(?:0|[1-9]\d{0,17})(?:\.\d{1,12})?$/);
const currencies = new Set(Intl.supportedValuesOf('currency'));
export const mcfMoney = z.object({
  currencyCode: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .refine((v) => currencies.has(v)),
  amount: mcfDecimal,
});
const quantityValue = z
  .string()
  .regex(/^(?:0|[1-9]\d{0,6})(?:\.0{1,12})?$/)
  .refine((v) => BigInt(v.split('.')[0]) <= 1000000n);
const qty = (v: string) => BigInt(v.split('.')[0]);
const amount = z.object({ unit: z.literal('EACHES').optional(), value: quantityValue });
const positiveAmount = amount.refine((v) => qty(v.value) > 0n);
const productId = z.object({ amazonSku: mcfSku });
const product = z.object({
  productIdentifier: productId,
  perUnitDeclaredValue: mcfMoney.optional(),
});
export const mcfAddress = z.strictObject({
  name: clean(200),
  addressLine1: clean(300),
  addressLine2: clean(300).optional(),
  addressLine3: clean(300).optional(),
  city: clean(150).optional(),
  districtOrCounty: clean(150).optional(),
  stateOrRegion: clean(150).optional(),
  postalCode: clean(30),
  countryCode: country,
  phone: clean(50).optional(),
  email: z.email().max(254).optional(),
});
const tiers = z.enum(['STANDARD', 'EXPEDITED', 'PRIORITY', 'SCHEDULED']);
const interval = z
  .object({ startTime: time, endTime: time })
  .refine((v) => Date.parse(v.startTime) <= Date.parse(v.endTime));
const packaging = z.strictObject({
  packagingOption: z.enum(['UNBRANDED', 'ANY']).optional(),
  overbox: z.enum(['REQUIRED', 'NOT_REQUIRED']).optional(),
});
export const mcfPreviewInput = z
  .strictObject({
    channel: clean(40).optional(),
    origin: z.strictObject({ countryCode: country }),
    destination: z.strictObject({ deliveryAddress: mcfAddress }),
    lineItems: z
      .array(
        z.strictObject({
          product: z.strictObject({
            productIdentifier: productId.strict(),
            perUnitDeclaredValue: mcfMoney.strict().optional(),
          }),
          amount: z
            .strictObject({ unit: z.literal('EACHES'), value: quantityValue })
            .refine((v) => qty(v.value) > 0n),
        }),
      )
      .min(1)
      .max(100),
    fulfillmentConfiguration: z
      .strictObject({
        serviceLevel: z
          .strictObject({
            serviceTiers: z
              .array(tiers)
              .min(1)
              .max(4)
              .refine((v) => new Set(v).size === v.length),
          })
          .optional(),
        services: z.strictObject({ packaging: packaging.optional() }).optional(),
      })
      .optional(),
    excludeEstimatedFees: z.boolean().default(false),
    includePaymentOnDelivery: z.literal(false).default(false),
  })
  .refine(
    (v) =>
      new Set(v.lineItems.map((i) => i.product.productIdentifier.amazonSku)).size ===
      v.lineItems.length,
    'Powtórzone SKU podglądu MCF',
  );
export type McfPreviewInput = z.infer<typeof mcfPreviewInput>;
const url = clean(8192).refine((v) => {
  try {
    const u = new URL(v);
    return u.protocol === 'https:' && !u.username && !u.password;
  } catch {
    return false;
  }
});
const serviceLevel = z.object({
  serviceTier: tiers.optional(),
  deliveryInterval: interval.optional(),
  shipInterval: interval.optional(),
});
const prices = z
  .object({
    rollupPrices: z.array(z.object({ type: clean(150), value: mcfMoney })).max(100),
    totalPrice: mcfMoney,
  })
  .refine((v) => v.rollupPrices.every((p) => p.value.currencyCode === v.totalPrice.currencyCode));
const previewSchema = z.object({
  plannedShipments: z
    .array(
      z.object({
        estimatedShippingWeight: z
          .object({ unit: z.enum(['KG', 'KILOGRAMS', 'LB', 'POUNDS']), value: mcfDecimal })
          .optional(),
        items: z.array(z.object({ productIdentifier: productId, amount: positiveAmount })).max(100),
        offers: z
          .array(
            z.object({
              estimatedPrice: prices.optional(),
              fulfillmentConfiguration: z
                .object({
                  serviceLevel: serviceLevel.optional(),
                  services: z
                    .object({
                      packaging: packaging.optional(),
                      delivery: z.object({ paymentOnDelivery: clean(40).optional() }).optional(),
                      additional: z.record(clean(100), clean(2000, true)).optional(),
                    })
                    .optional(),
                })
                .optional(),
            }),
          )
          .max(100)
          .optional(),
      }),
    )
    .max(100),
  constraints: z
    .array(
      z.object({
        type: clean(200),
        code: clean(200),
        message: clean(4000),
        details: z
          .array(z.object({ type: clean(200), value: clean(4000, true) }))
          .max(100)
          .optional(),
      }),
    )
    .max(100)
    .optional(),
});
const orderStatus = z.enum([
  'PROCESSING',
  'COMPLETE',
  'COMPLETE_PARTIAL',
  'CANCELLED',
  'UNFULFILLABLE',
  'INVALID',
]);
const shipmentStatus = z.enum(['PROCESSING', 'SHIPPED', 'CANCELLED']);
const packageStatus = z.enum([
  'PROCESSING',
  'IN_TRANSIT',
  'DELAYED',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
  'UNDELIVERABLE',
  'EXPIRED',
]);
const tracking = z.object({
  carrier: z
    .object({
      carrierCode: clean(200),
      trackingNumber: clean(200).optional(),
      trackingUrl: url.optional(),
    })
    .optional(),
  amazon: z
    .object({ trackingNumber: clean(200).optional(), trackingUrl: url.optional() })
    .optional(),
  proofOfDelivery: z
    .object({ deliveryPhotoUrl: url.optional(), receivedBy: clean(200).optional() })
    .optional(),
});
const orderSchema = z.object({
  orderId: mcfId,
  receiveTime: time,
  status: orderStatus.optional(),
  statusUpdateTime: time.optional(),
  channel: clean(40).optional(),
  origin: z.object({ countryCode: country }).optional(),
  destination: z
    .object({ deliveryAddress: mcfAddress, deliveryNotes: clean(4000, true).optional() })
    .optional(),
  fulfillmentConfiguration: z
    .object({
      action: z.enum(['SHIP', 'HOLD']).optional(),
      policy: z.enum(['FILL_OR_KILL', 'FILL_ALL', 'FILL_ALL_AVAILABLE']).optional(),
      serviceLevel: z
        .object({
          serviceTiers: z.array(tiers).max(4).optional(),
          deliveryInterval: interval.optional(),
        })
        .optional(),
    })
    .optional(),
  lineItems: z
    .array(
      z.object({
        lineItemId: clean(100),
        product,
        amount: positiveAmount,
        cancelledAmount: amount.optional(),
        unfulfillableAmount: amount.optional(),
      }),
    )
    .max(100),
  shipments: z
    .array(
      z.object({
        amazonShipmentId: clean(100),
        amazonFacility: z.object({ facilityId: mcfId, address: mcfAddress.optional() }),
        status: shipmentStatus,
        shipTime: time.optional(),
        deliveryTime: time.optional(),
        shippingNotes: z.array(clean(2000, true)).max(100).optional(),
        items: z
          .array(
            z.object({
              lineItemId: clean(100),
              productIdentifier: productId,
              amount: positiveAmount,
              packageId: mcfId.optional(),
              shipmentItemId: clean(100).optional(),
              unitIdentifiers: z.record(clean(100), z.array(clean(200)).max(100)).optional(),
            }),
          )
          .max(100),
        packages: z
          .array(
            z.object({
              packageId: mcfId,
              status: packageStatus.optional(),
              deliveryTime: time.optional(),
              tracking: tracking.optional(),
              shipmentItemIds: z.array(clean(100)).max(100).optional(),
            }),
          )
          .max(100)
          .optional(),
      }),
    )
    .max(100)
    .optional(),
});
export type McfOrder = z.infer<typeof orderSchema>;
function parsed<T>(schema: z.ZodType<T>, raw: unknown, label: string): T {
  const p = schema.safeParse(raw);
  ensure(p.success, 502, 'Niepełna lub nieprawidłowa odpowiedź Amazon MCF: ' + label);
  return p.data;
}
const unique = (v: string[], label: string) =>
  ensure(new Set(v).size === v.length, 502, 'Powtórzone identyfikatory Amazon MCF: ' + label);

export function parseMcfPreview(raw: unknown, requested: McfPreviewInput) {
  const request = mcfPreviewInput.parse(requested),
    response = parsed(previewSchema, raw, 'podgląd');
  const wanted = new Map(
    request.lineItems.map((i) => [i.product.productIdentifier.amazonSku, qty(i.amount.value)]),
  );
  const totals = new Map<string, bigint>();
  for (const shipment of response.plannedShipments) {
    unique(
      shipment.items.map((i) => i.productIdentifier.amazonSku),
      'SKU przesyłki podglądu',
    );
    for (const i of shipment.items) {
      const sku = i.productIdentifier.amazonSku;
      ensure(wanted.has(sku), 502, 'Amazon MCF zwrócił inne SKU podglądu');
      totals.set(sku, (totals.get(sku) ?? 0n) + qty(i.amount.value));
      ensure(
        totals.get(sku)! <= wanted.get(sku)!,
        502,
        'Amazon MCF zwrócił nadmiarową ilość podglądu',
      );
    }
    for (const offer of shipment.offers ?? []) {
      const tier = offer.fulfillmentConfiguration?.serviceLevel?.serviceTier;
      ensure(
        !tier ||
          !request.fulfillmentConfiguration?.serviceLevel ||
          request.fulfillmentConfiguration.serviceLevel.serviceTiers.includes(tier),
        502,
        'Amazon MCF zwrócił inny poziom dostawy',
      );
    }
  }
  return {
    ...response,
    completeQuantityCoverage: [...wanted].every(([sku, n]) => totals.get(sku) === n),
    hasConstraints: Boolean(response.constraints?.length),
    hasOffersForEveryShipment:
      response.plannedShipments.length > 0 &&
      response.plannedShipments.every((s) => Boolean(s.offers?.length)),
    hasPricesForEveryOffer:
      response.plannedShipments.length > 0 &&
      response.plannedShipments.every(
        (s) => Boolean(s.offers?.length) && s.offers!.every((o) => Boolean(o.estimatedPrice)),
      ),
  };
}
export function parseMcfOrder(raw: unknown, expectedId?: string): McfOrder {
  const order = parsed(orderSchema, raw, 'zamówienie');
  ensure(!expectedId || order.orderId === expectedId, 502, 'Amazon MCF zwrócił inne zamówienie');
  unique(
    order.lineItems.map((i) => i.lineItemId),
    'pozycje zamówienia',
  );
  unique(
    (order.shipments ?? []).map((s) => s.amazonShipmentId),
    'przesyłki',
  );
  unique(
    (order.shipments ?? []).flatMap((s) => (s.packages ?? []).map((p) => p.packageId)),
    'paczki',
  );
  const sent = new Map<string, bigint>();
  for (const i of order.lineItems)
    ensure(
      qty(i.cancelledAmount?.value ?? '0') + qty(i.unfulfillableAmount?.value ?? '0') <=
        qty(i.amount.value),
      502,
      'Nieprawidłowe ilości anulowane MCF',
    );
  for (const s of order.shipments ?? []) {
    unique(
      s.items.filter((i) => i.shipmentItemId).map((i) => i.shipmentItemId!),
      'pozycje przesyłki',
    );
    for (const i of s.items) {
      const line = order.lineItems.find((l) => l.lineItemId === i.lineItemId);
      ensure(
        line && line.product.productIdentifier.amazonSku === i.productIdentifier.amazonSku,
        502,
        'Przesyłka MCF dotyczy innej pozycji lub SKU',
      );
      if (s.status !== 'CANCELLED') {
        sent.set(i.lineItemId, (sent.get(i.lineItemId) ?? 0n) + qty(i.amount.value));
        ensure(
          sent.get(i.lineItemId)! <= qty(line.amount.value),
          502,
          'Nadmiarowa ilość przesyłek MCF',
        );
      }
      if (i.packageId && s.packages)
        ensure(
          s.packages.some((p) => p.packageId === i.packageId),
          502,
          'Pozycja MCF wskazuje inną paczkę',
        );
    }
    for (const p of s.packages ?? []) {
      unique(p.shipmentItemIds ?? [], 'pozycje paczki');
      ensure(
        (p.shipmentItemIds ?? []).every((id) => s.items.some((i) => i.shipmentItemId === id)),
        502,
        'Paczka MCF wskazuje inną pozycję',
      );
    }
  }
  return order;
}
export function mcfPackageTracking(order: McfOrder) {
  return (order.shipments ?? []).flatMap((s) =>
    (s.packages ?? []).map((p) => ({
      orderId: order.orderId,
      shipmentId: s.amazonShipmentId,
      packageId: p.packageId,
      orderStatus: order.status ?? null,
      shipmentStatus: s.status,
      packageStatus: p.status ?? null,
      deliveryTime: p.deliveryTime ?? s.deliveryTime ?? null,
      tracking: p.tracking ?? null,
    })),
  );
}
const pageInput = z.strictObject({
  updatedAfter: time,
  shipments: z.enum(['INCLUDE', 'EXCLUDE']).default('INCLUDE'),
  pageToken: clean(16000).optional(),
});
export type McfPageInput = z.input<typeof pageInput>;
export function parseMcfPage(raw: unknown) {
  const p = parsed(
    z.object({
      orders: z.array(z.unknown()).max(1000),
      pagination: z.object({ nextToken: clean(16000).nullable().optional() }).optional(),
    }),
    raw,
    'strona',
  );
  const orders = p.orders.map((o) => parseMcfOrder(o));
  unique(
    orders.map((o) => o.orderId),
    'zamówienia strony',
  );
  return { orders, nextToken: p.pagination?.nextToken ?? null };
}

export type McfAuth = Pick<Amazon, 'token' | 'mode' | 'settings'>;
export class AmazonMcf {
  readonly originCountry: string;
  readonly fulfillmentServiceId?: string;
  private readonly base: string;
  constructor(
    private auth: McfAuth,
    private transport: Transport,
    scope: { originCountry: string; fulfillmentServiceId?: string },
  ) {
    ensure(
      AMAZON_MARKETS[auth.settings.marketplace_id] === auth.settings.region,
      422,
      'Marketplace nie pasuje do regionu MCF',
    );
    this.base = amazonBase(auth.mode, auth.settings.region);
    this.originCountry = country.parse(scope.originCountry);
    this.fulfillmentServiceId =
      scope.fulfillmentServiceId === undefined
        ? undefined
        : mcfId.parse(scope.fulfillmentServiceId);
  }
  private async request(
    path: string,
    query: Record<string, string>,
    fence?: () => Promise<void>,
    body?: McfPreviewInput,
  ) {
    const u = new URL(this.base + AMAZON_MCF_PATH + path);
    for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
    let access: string;
    try {
      access = await this.auth.token(fence);
    } catch (e) {
      if (e instanceof Problem) throw e;
      throw new Problem(502, 'Brak odpowiedzi autoryzacji Amazon MCF');
    }
    ensure(
      typeof access === 'string' && /^[^\s\x00-\x1f\x7f]{1,2048}$/.test(access),
      401,
      'Brak aktualnego tokenu Amazon',
    );
    await fence?.();
    let r: Response;
    try {
      r = await this.transport(u.toString(), {
        method: body ? 'POST' : 'GET',
        redirect: 'error',
        headers: {
          Accept: 'application/json',
          'x-amz-access-token': access,
          'x-amz-date': new Date().toISOString().replace(/[-:]|\.\d{3}/g, ''),
          'User-Agent': 'DYNAMINDS-Ecommerce/1.0 (Language=TypeScript)',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(this.fulfillmentServiceId
            ? { 'x-amzn-fulfillment-service-id': this.fulfillmentServiceId }
            : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch (e) {
      if (e instanceof Problem) throw e;
      throw new Problem(502, 'Brak odpowiedzi Amazon MCF');
    }
    try {
      ensure(
        r.status === 200,
        [400, 401, 403, 404, 413, 415, 429].includes(r.status) ? r.status : 502,
        'Amazon MCF: HTTP ' + r.status,
      );
      let responseOrigin: string | undefined;
      try {
        responseOrigin = r.url ? new URL(r.url).origin : undefined;
      } catch {
        throw new Problem(502, 'Nieprawidłowy adres odpowiedzi Amazon MCF');
      }
      ensure(
        !responseOrigin || responseOrigin === this.base,
        502,
        'Amazon MCF zwrócił przekierowaną odpowiedź',
      );
      if (this.fulfillmentServiceId)
        ensure(
          r.headers.get('x-amzn-fulfillment-service-id') === this.fulfillmentServiceId,
          502,
          'Odpowiedź MCF dotyczy innej lub niepotwierdzonej usługi',
        );
    } catch (e) {
      await r.body?.cancel().catch(() => {});
      throw e;
    }
    const reader = r.body?.getReader();
    ensure(reader, 502, 'Brak odpowiedzi Amazon MCF');
    let raw: unknown;
    try {
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const p = await reader.read();
        if (p.done) break;
        size += p.value.byteLength;
        ensure(size <= 5 * 1024 * 1024, 502, 'Odpowiedź MCF przekracza 5 MB');
        chunks.push(p.value);
      }
      raw = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (e) {
      if (e instanceof Problem) throw e;
      throw new Problem(502, 'Nieprawidłowa odpowiedź JSON Amazon MCF');
    } finally {
      await reader.cancel().catch(() => {});
    }
    const envelope = parsed(
      z.object({
        errors: z
          .array(
            z.object({
              code: clean(200),
              message: clean(4000),
              details: clean(8000, true).optional(),
            }),
          )
          .max(100)
          .optional(),
      }),
      raw,
      'obiekt',
    );
    ensure(!envelope.errors?.length, 502, 'Amazon MCF zwrócił błędy zamiast wyniku');
    await fence?.();
    return raw;
  }
  async preview(input: unknown, fence?: () => Promise<void>) {
    const b = mcfPreviewInput.parse(input);
    ensure(
      b.origin.countryCode === this.originCountry,
      422,
      'Podgląd dotyczy innego kraju zapasu MCF',
    );
    const tier = b.fulfillmentConfiguration?.serviceLevel?.serviceTiers ?? [];
    ensure(
      !tier.includes('SCHEDULED') || this.originCountry === 'JP',
      422,
      'SCHEDULED dotyczy Japonii',
    );
    ensure(
      !tier.includes('PRIORITY') || ['CA', 'IN', 'MX'].includes(this.originCountry),
      422,
      'PRIORITY dotyczy CA, IN lub MX',
    );
    return parseMcfPreview(await this.request('/previews', {}, fence, b), b);
  }
  async order(id: string, fence?: () => Promise<void>) {
    mcfId.parse(id);
    return parseMcfOrder(
      parsed(
        z.object({ order: z.unknown() }),
        await this.request('/orders/' + encodeURIComponent(id), { shipments: 'INCLUDE' }, fence),
        'zamówienie',
      ).order,
      id,
    );
  }
  async page(input: McfPageInput, fence?: () => Promise<void>) {
    const q = pageInput.parse(input);
    return parseMcfPage(
      await this.request(
        '/orders',
        {
          updatedAfter: q.updatedAfter,
          shipments: q.shipments,
          ...(q.pageToken ? { pageToken: q.pageToken } : {}),
        },
        fence,
      ),
    );
  }
  async orders(
    input: Omit<McfPageInput, 'pageToken'>,
    fence?: () => Promise<void>,
    bounds = { maxPages: 100, maxOrders: 10000 },
  ) {
    const q = pageInput.parse(input),
      limit = z
        .strictObject({
          maxPages: z.number().int().min(1).max(100),
          maxOrders: z.number().int().min(1).max(10000),
        })
        .parse(bounds);
    ensure(!q.pageToken, 422, 'Pełny odczyt MCF musi zaczynać od pierwszej strony');
    const tokens = new Set<string>(),
      ids = new Set<string>(),
      orders: McfOrder[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < limit.maxPages; page++) {
      const p = await this.page({ ...q, pageToken }, fence);
      for (const o of p.orders) {
        ensure(!ids.has(o.orderId), 502, 'Powtórzone zamówienie między stronami MCF');
        ids.add(o.orderId);
        orders.push(o);
      }
      ensure(orders.length <= limit.maxOrders, 502, 'Przekroczono limit zamówień odczytu MCF');
      if (!p.nextToken) return { orders, pages: page + 1, complete: true as const };
      ensure(!tokens.has(p.nextToken), 502, 'Powtórzony token strony MCF');
      tokens.add(p.nextToken);
      pageToken = p.nextToken;
    }
    throw new Problem(502, 'Przekroczono limit stron MCF; nie uznano odczytu za kompletny');
  }
}
