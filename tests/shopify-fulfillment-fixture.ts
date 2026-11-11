import { demoShopifyOrder } from '../server/shopify-example';
import { demoShopifyFulfillmentState } from '../server/shopify-fulfillment';
import { SHOPIFY_VERSION } from '../server/shopify';
export function shopifyFulfillmentFixture() {
  const state = {
    raw: structuredClone(demoShopifyOrder) as any,
    orders: null as any,
    fulfillments: [] as any[],
    scopes: [
      'read_orders',
      'read_merchant_managed_fulfillment_orders',
      'write_merchant_managed_fulfillment_orders',
    ],
    apply: true,
    lose: false,
    post: 200,
    hide: false,
    reads: 0,
    mutate: null as null | ((d: any) => void | Promise<void>),
    beforeWrite: null as null | (() => Promise<void>),
    badVersion: false,
    foPage: 25,
    linePage: 25,
    badCount: false,
  };
  const calls: { url: string; query: string; variables: any }[] = [];
  const page = (nodes: any[], after: string | null, size: number) => {
    const offset = after ? Number(after) : 0;
    return {
      nodes: structuredClone(nodes.slice(offset, offset + size)),
      pageInfo: { hasNextPage: offset + size < nodes.length, endCursor: String(offset + size) },
    };
  };
  const full = (v: any) => ({
    id: v.id,
    status: v.status,
    order: { id: v.order_id },
    location: { id: v.location_id },
    trackingInfo: v.tracking,
    fulfillmentOrders: {
      nodes: v.fulfillment_order_ids.map((id: string) => ({ id })),
      pageInfo: { hasNextPage: false, endCursor: null },
    },
    fulfillmentLineItems: {
      nodes: v.lines.map((l: any, n: number) => ({
        id: 'gid://shopify/FulfillmentLineItem/' + (900000 + n),
        quantity: l.quantity,
        lineItem: { id: l.id },
      })),
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  });
  const transport = async (url: string, init: RequestInit) => {
    const b = JSON.parse(String(init.body));
    calls.push({ url, query: b.query, variables: b.variables });
    const domain = new URL(url).hostname;
    const reply = (data: any, status = 200) =>
      new Response(JSON.stringify({ data }), {
        status,
        headers: { 'X-Shopify-API-Version': state.badVersion ? '2026-07' : SHOPIFY_VERSION },
      });
    if (b.query.includes('mutation DynaFulfillmentCreate')) {
      await state.beforeWrite?.();
      const d = b.variables.fulfillment;
      if (state.apply) {
        const orders = state.orders ?? demoShopifyFulfillmentState(state.raw).orders;
        const lines = d.lineItemsByFulfillmentOrder.flatMap((o: any) =>
          o.fulfillmentOrderLineItems.map((l: any) => {
            const original = orders
              .find((f: any) => f.id === o.fulfillmentOrderId)
              .lineItems.find((i: any) => i.id === l.id);
            return { id: original.lineItem.id, quantity: l.quantity };
          }),
        );
        const totals = new Map<string, number>();
        for (const l of lines) totals.set(l.id, (totals.get(l.id) ?? 0) + l.quantity);
        state.fulfillments.push({
          id: 'gid://shopify/Fulfillment/88001',
          status: 'SUCCESS',
          order_id: state.raw.id,
          location_id: orders.find(
            (o: any) => o.id === d.lineItemsByFulfillmentOrder[0].fulfillmentOrderId,
          ).assignedLocation.location.id,
          lines: [...totals]
            .map(([id, quantity]) => ({ id, quantity }))
            .sort((a, b) => a.id.localeCompare(b.id)),
          fulfillment_order_ids: d.lineItemsByFulfillmentOrder
            .map((o: any) => o.fulfillmentOrderId)
            .sort(),
          tracking: [d.trackingInfo],
        });
      }
      if (state.lose) throw Error('PRIVATE RESPONSE TOKEN');
      if (state.post !== 200)
        return new Response('{}', { status: state.post, headers: { 'retry-after': '1' } });
      return reply({
        fulfillmentCreate: {
          fulfillment: { id: 'gid://shopify/Fulfillment/88001', order: { id: state.raw.id } },
          userErrors: [],
        },
      });
    }
    if (b.query.includes('DynaFulfillmentLines')) {
      const orders =
          state.orders ?? demoShopifyFulfillmentState(state.raw, state.fulfillments).orders,
        o = orders.find((v: any) => v.id === b.variables.id);
      return reply({
        shop: { myshopifyDomain: domain },
        fulfillmentOrder: { ...o, lineItems: page(o.lineItems, b.variables.after, state.linePage) },
      });
    }
    if (b.query.includes('DynaFulfillmentState')) {
      state.reads++;
      const v = demoShopifyFulfillmentState(state.raw, state.fulfillments),
        orders = state.orders ?? v.orders,
        raw = v.raw;
      const d = {
        shop: { myshopifyDomain: domain },
        currentAppInstallation: { accessScopes: state.scopes.map((handle) => ({ handle })) },
        order: {
          ...raw,
          fulfillmentOrders: page(
            orders.map((o: any) => ({ ...o, lineItems: page(o.lineItems, null, state.linePage) })),
            b.variables.after,
            state.foPage,
          ),
          fulfillmentsCount: {
            count: state.fulfillments.length + (state.badCount ? 1 : 0),
            precision: 'EXACT',
          },
          fulfillments: state.hide ? [] : state.fulfillments.map(full),
        },
      };
      await state.mutate?.(d);
      return reply(d);
    }
    if (b.query.includes('DynaOrders'))
      return reply({
        orders: { nodes: [state.raw], pageInfo: { hasNextPage: false, endCursor: 'end' } },
      });
    if (b.query.includes('query DynaOrder('))
      return reply({
        shop: { id: 'gid://shopify/Shop/1', myshopifyDomain: domain },
        order: state.raw,
      });
    if (b.query.includes('DynaShop'))
      return reply({
        shop: {
          id: 'gid://shopify/Shop/1',
          myshopifyDomain: domain,
          name: 'QA Shopify',
          currencyCode: 'PLN',
        },
        currentAppInstallation: { accessScopes: state.scopes.map((handle) => ({ handle })) },
      });
    throw Error('Unexpected fixed Shopify query');
  };
  return { state, calls, transport };
}
