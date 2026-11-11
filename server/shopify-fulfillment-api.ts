import { z } from 'zod';
import { ensure } from './errors';
const gid = (kind: string) =>
  z.string().regex(new RegExp('^gid://shopify/' + kind + '/[1-9]\\d{0,19}$'));
const quantity = z.number().int().min(1).max(1000000);
export const shopifyFulfillmentBody = z
  .object({
    lineItemsByFulfillmentOrder: z
      .array(
        z
          .object({
            fulfillmentOrderId: gid('FulfillmentOrder'),
            fulfillmentOrderLineItems: z
              .array(z.object({ id: gid('FulfillmentOrderLineItem'), quantity }).strict())
              .min(1)
              .max(100),
          })
          .strict(),
      )
      .min(1)
      .max(100),
    notifyCustomer: z.boolean(),
    trackingInfo: z
      .object({
        company: z
          .string()
          .trim()
          .min(1)
          .max(100)
          .regex(/^[^\x00-\x1f\x7f]+$/),
        number: z.string().regex(/^[A-Za-z0-9-]{1,100}$/),
      })
      .strict(),
  })
  .strict()
  .superRefine((v, ctx) => {
    const ids = v.lineItemsByFulfillmentOrder.map((x) => x.fulfillmentOrderId),
      lines = v.lineItemsByFulfillmentOrder.flatMap((x) =>
        x.fulfillmentOrderLineItems.map((i) => i.id),
      );
    if (
      new Set(ids).size !== ids.length ||
      new Set(lines).size !== lines.length ||
      lines.length > 100
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Powtórzone lub zbyt liczne pozycje realizacji Shopify',
      });
  });
export const shopifyFulfillmentLineFields =
  'id totalQuantity remainingQuantity requiresShipping lineItem { id sku variant { id } }';
export const shopifyFulfillmentOrderFields = `id orderId status requestStatus updatedAt supportedActions { action } assignedLocation { location { id isActive fulfillsOnlineOrders } } lineItems(first:25) { nodes { ${shopifyFulfillmentLineFields} } pageInfo { hasNextPage endCursor } }`;
export const shopifyFulfillmentFields =
  'id status order { id } location { id } trackingInfo { company number } fulfillmentOrders(first:100) { nodes { id } pageInfo { hasNextPage endCursor } } fulfillmentLineItems(first:100) { nodes { id quantity lineItem { id } } pageInfo { hasNextPage endCursor } }';
export function shopifyFulfillmentPage(
  raw: any,
  kind: string,
  limit: number,
  after: string | null = null,
) {
  ensure(
    raw &&
      Array.isArray(raw.nodes) &&
      raw.nodes.length <= limit &&
      typeof raw.pageInfo?.hasNextPage === 'boolean',
    502,
    'Nieprawidłowa strona realizacji Shopify',
  );
  const ids = raw.nodes.map((v: any) => gid(kind).parse(v?.id)),
    cursor = raw.pageInfo.endCursor;
  ensure(new Set(ids).size === ids.length, 502, 'Powtórzone rekordy realizacji Shopify');
  ensure(
    cursor == null ||
      (typeof cursor === 'string' &&
        cursor.length > 0 &&
        cursor.length <= 2048 &&
        !/[\x00-\x1f]/.test(cursor)),
    502,
    'Nieprawidłowy cursor realizacji Shopify',
  );
  ensure(
    !raw.pageInfo.hasNextPage || (ids.length > 0 && cursor && cursor !== after),
    502,
    'Brak postępu realizacji Shopify',
  );
  return {
    data: raw.nodes as any[],
    more: raw.pageInfo.hasNextPage as boolean,
    cursor: cursor ?? null,
  };
}
export function shopifyFulfillmentCollection(values: any, orderId: string) {
  ensure(Array.isArray(values) && values.length <= 100, 502, 'Niepełna kolekcja przesyłek Shopify');
  const ids = new Set<string>();
  return values
    .map((v) => {
      const id = gid('Fulfillment').parse(v.id);
      ensure(
        !ids.has(id) && v.order?.id === orderId && typeof v.status === 'string',
        502,
        'Obca lub powtórzona realizacja Shopify',
      );
      ids.add(id);
      const items = shopifyFulfillmentPage(v.fulfillmentLineItems, 'FulfillmentLineItem', 100),
        orders = shopifyFulfillmentPage(v.fulfillmentOrders, 'FulfillmentOrder', 100);
      ensure(
        !items.more && !orders.more,
        422,
        'Przesyłka Shopify przekracza zakres kompletnych pozycji',
      );
      gid('Location').parse(v.location?.id);
      const lines = items.data
        .map((i) => ({
          id: gid('LineItem').parse(i.lineItem?.id),
          quantity: quantity.parse(i.quantity),
        }))
        .sort((a, b) => a.id.localeCompare(b.id));
      ensure(
        new Set(lines.map((i) => i.id)).size === lines.length,
        502,
        'Powtórzone pozycje przesyłki Shopify',
      );
      const tracking = z
        .array(z.object({ company: z.string().nullable(), number: z.string().nullable() }))
        .max(100)
        .parse(v.trackingInfo);
      return {
        id,
        status: v.status,
        order_id: orderId,
        location_id: v.location.id,
        lines,
        fulfillment_order_ids: orders.data.map((i) => i.id).sort(),
        tracking,
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}
